const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const { simpleParser } = require("mailparser");
const sanitizeHtml = require("sanitize-html");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 8
});

const required = ["DATABASE_URL", "SESSION_SECRET", "INBOUND_SECRET", "ADMIN_PASSWORD_HASH"];
for (const key of required) {
  if (!process.env[key]) {
    console.error("Missing required environment variable: " + key);
    process.exit(1);
  }
}

app.set("trust proxy", 1);
app.use(helmet());
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { etag: true, maxAge: "1h" }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS domains (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mailboxes (
      id BIGSERIAL PRIMARY KEY,
      domain_id BIGINT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
      local_part TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(domain_id, local_part)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      mailbox_id BIGINT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      message_id TEXT,
      sender TEXT NOT NULL DEFAULT '',
      recipient TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '(no subject)',
      text_body TEXT NOT NULL DEFAULT '',
      html_body TEXT NOT NULL DEFAULT '',
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE INDEX IF NOT EXISTS messages_mailbox_received_idx ON messages(mailbox_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS messages_message_id_idx ON messages(message_id);
  `);
}

function auth(req, res, next) {
  const token = req.cookies.mailbox_session;
  if (!token) return res.status(401).json({ error: "Sign in required" });
  try {
    req.user = jwt.verify(token, process.env.SESSION_SECRET);
    next();
  } catch {
    res.clearCookie("mailbox_session");
    return res.status(401).json({ error: "Session expired" });
  }
}

function cleanDomain(value) {
  const d = String(value || "").trim().toLowerCase().replace(/^@/, "");
  if (d.length > 253 || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) {
    throw new Error("Enter a valid domain name.");
  }
  return d;
}

function cleanLocal(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(v) || v.includes("..")) {
    throw new Error("Mailbox names may use letters, numbers, dots, underscores, plus signs, and hyphens.");
  }
  return v;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/login", loginLimiter, async (req, res) => {
  const password = String(req.body.password || "");
  const ok = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
  if (!ok) return res.status(401).json({ error: "Incorrect password" });
  const token = jwt.sign({ role: "admin" }, process.env.SESSION_SECRET, { expiresIn: "7d" });
  res.cookie("mailbox_session", token, {
    httpOnly: true, secure: process.env.NODE_ENV === "production",
    sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000, path: "/"
  });
  res.json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  res.clearCookie("mailbox_session", { path: "/" });
  res.json({ ok: true });
});

app.get("/api/me", auth, (_req, res) => res.json({ authenticated: true }));

// Cloudflare Email Worker posts the original RFC 5322 message here.
// Keep this route outside the dashboard session, but require a separate secret.
app.post("/api/inbound", express.raw({ type: "*/*", limit: "26mb" }), async (req, res) => {
  const secret = req.get("authorization") || "";
  if (secret !== "Bearer " + process.env.INBOUND_SECRET) return res.status(401).send("Unauthorized");
  const recipient = String(req.get("x-envelope-to") || "").trim().toLowerCase();
  if (!recipient || !recipient.includes("@")) return res.status(400).send("Missing recipient");
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).send("Missing raw message");
  try {
    const parsed = await simpleParser(req.body);
    const address = recipient.split("@");
    const domain = cleanDomain(address.pop());
    const local = cleanLocal(address.join("@"));
    const found = await pool.query(
      "SELECT m.id FROM mailboxes m JOIN domains d ON d.id=m.domain_id WHERE d.name=$1 AND m.local_part=$2",
      [domain, local]
    );
    if (!found.rowCount) return res.status(404).send("Recipient is not configured");
    const attachments = (parsed.attachments || []).map((a) => ({
      filename: String(a.filename || "attachment").slice(0, 180),
      contentType: a.contentType || "application/octet-stream",
      size: a.size || 0,
      content: a.content.toString("base64")
    }));
    await pool.query(
      `INSERT INTO messages (mailbox_id,message_id,sender,recipient,subject,text_body,html_body,received_at,attachments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [
        found.rows[0].id, parsed.messageId || null,
        parsed.from?.text || "", recipient,
        String(parsed.subject || "(no subject)").slice(0, 998),
        String(parsed.text || "").slice(0, 1000000),
        sanitizeHtml(String(parsed.html || ""), {
          allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2", "u"]),
          allowedAttributes: { a: ["href", "name", "target"], img: ["src", "alt", "width", "height"], "*": ["style"] },
          allowedSchemes: ["http", "https", "mailto", "cid"],
          disallowedTagsMode: "discard"
        }).slice(0, 1000000),
        parsed.date || new Date(), JSON.stringify(attachments)
      ]
    );
    res.status(202).send("Accepted");
  } catch (err) {
    console.error("Inbound message processing failed:", err.message);
    res.status(500).send("Message processing failed");
  }
});

app.use("/api", apiLimiter, auth);

app.get("/api/domains", async (_req, res) => {
  const result = await pool.query(`
    SELECT d.id,d.name,d.created_at,COUNT(DISTINCT m.id)::int AS mailbox_count,
      COUNT(msg.id)::int AS message_count
    FROM domains d LEFT JOIN mailboxes m ON m.domain_id=d.id
    LEFT JOIN messages msg ON msg.mailbox_id=m.id
    GROUP BY d.id ORDER BY d.name
  `);
  res.json(result.rows);
});

app.post("/api/domains", async (req, res) => {
  try {
    const name = cleanDomain(req.body.name);
    const result = await pool.query("INSERT INTO domains(name) VALUES($1) ON CONFLICT(name) DO NOTHING RETURNING *", [name]);
    if (!result.rowCount) return res.status(409).json({ error: "That domain is already added." });
    res.status(201).json(result.rows[0]);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/domains/:id", async (req, res) => {
  await pool.query("DELETE FROM domains WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

app.get("/api/mailboxes", async (req, res) => {
  const params = [];
  let where = "";
  if (req.query.domain) { params.push(req.query.domain); where = "WHERE d.id=$1"; }
  const result = await pool.query(`
    SELECT m.id,m.local_part,d.name AS domain,
      COUNT(msg.id)::int AS message_count,
      COUNT(msg.id) FILTER (WHERE msg.is_read=false)::int AS unread_count
    FROM mailboxes m JOIN domains d ON d.id=m.domain_id
    LEFT JOIN messages msg ON msg.mailbox_id=m.id ${where}
    GROUP BY m.id,d.name ORDER BY d.name,m.local_part
  `, params);
  res.json(result.rows);
});

app.post("/api/mailboxes", async (req, res) => {
  try {
    const domainId = Number(req.body.domainId);
    const local = cleanLocal(req.body.localPart);
    const result = await pool.query(
      "INSERT INTO mailboxes(domain_id,local_part) VALUES($1,$2) RETURNING id,local_part",
      [domainId, local]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(400).json({ error: e.code === "23503" ? "Choose a valid domain." : e.code === "23505" ? "That address already exists." : e.message });
  }
});

app.post("/api/mailboxes/bulk", async (req, res) => {
  const domainId = Number(req.body.domainId);
  const start = Number(req.body.start);
  const count = Number(req.body.count);
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 100) {
    return res.status(400).json({ error: "Choose a start number and a batch size from 1 to 100." });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = [];
    for (let n = start; n < start + count; n++) {
      const r = await client.query(
        "INSERT INTO mailboxes(domain_id,local_part) VALUES($1,$2) ON CONFLICT(domain_id,local_part) DO NOTHING RETURNING local_part",
        [domainId, String(n)]
      );
      if (r.rowCount) created.push(r.rows[0].local_part);
    }
    await client.query("COMMIT");
    res.status(201).json({ created, skipped: count - created.length });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.code === "23503" ? "Choose a valid domain." : e.message });
  } finally { client.release(); }
});

app.delete("/api/mailboxes/:id", async (req, res) => {
  await pool.query("DELETE FROM mailboxes WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

app.get("/api/messages", async (req, res) => {
  const mailboxId = Number(req.query.mailbox);
  if (!mailboxId) return res.status(400).json({ error: "Choose a mailbox." });
  const q = String(req.query.q || "").trim().slice(0, 120);
  const params = [mailboxId];
  let search = "";
  if (q) { params.push("%" + q + "%"); search = "AND (subject ILIKE $2 OR sender ILIKE $2 OR text_body ILIKE $2)"; }
  const result = await pool.query(
    "SELECT id,sender,recipient,subject,received_at,is_read,LEFT(text_body,260) AS preview,jsonb_array_length(attachments) AS attachment_count FROM messages WHERE mailbox_id=$1 " + search + " ORDER BY received_at DESC LIMIT 100",
    params
  );
  res.json(result.rows);
});

app.get("/api/messages/:id", async (req, res) => {
  const result = await pool.query(
    "SELECT id,sender,recipient,subject,received_at,is_read,text_body,html_body,attachments FROM messages WHERE id=$1",
    [req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: "Message not found." });
  await pool.query("UPDATE messages SET is_read=true WHERE id=$1", [req.params.id]);
  const row = result.rows[0];
  row.attachments = (row.attachments || []).map((a, index) => ({
    index, filename: a.filename, contentType: a.contentType, size: a.size
  }));
  res.json(row);
});

app.get("/api/messages/:id/attachments/:index", async (req, res) => {
  const result = await pool.query("SELECT attachments FROM messages WHERE id=$1", [req.params.id]);
  if (!result.rowCount) return res.sendStatus(404);
  const a = (result.rows[0].attachments || [])[Number(req.params.index)];
  if (!a) return res.sendStatus(404);
  const data = Buffer.from(a.content, "base64");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(a.filename || "attachment"));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(data);
});

app.delete("/api/messages/:id", async (req, res) => {
  await pool.query("DELETE FROM messages WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

app.post("/api/messages/:id/read", async (req, res) => {
  await pool.query("UPDATE messages SET is_read=$2 WHERE id=$1", [req.params.id, Boolean(req.body.read)]);
  res.json({ ok: true });
});

app.use((_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

initDb().then(() => {
  app.listen(PORT, "0.0.0.0", () => console.log("Mailbox listening on port " + PORT));
}).catch((err) => {
  console.error("Database initialization failed:", err.message);
  process.exit(1);
});
