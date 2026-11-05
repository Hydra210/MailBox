const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { simpleParser } = require("mailparser");
const sanitizeHtml = require("sanitize-html");
const path = require("path");
const crypto = require("crypto");
const store = require("./storage");

const app = express();
const PORT = process.env.PORT || 3000;
const required = ["SESSION_SECRET", "INBOUND_SECRET", "ADMIN_PASSWORD_HASH"];
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

function auth(req, res, next) {
  const token = req.cookies.mailbox_session;
  if (!token) return res.status(401).json({ error: "Sign in required" });
  try { req.user = jwt.verify(token, process.env.SESSION_SECRET); next(); }
  catch { res.clearCookie("mailbox_session"); return res.status(401).json({ error: "Session expired" }); }
}
function cleanDomain(value) {
  const d = String(value || "").trim().toLowerCase().replace(/^@/, "");
  if (d.length > 253 || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) throw new Error("Enter a valid domain name.");
  return d;
}
function cleanLocal(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(v) || v.includes("..")) throw new Error("Mailbox names may use letters, numbers, dots, underscores, plus signs, and hyphens.");
  return v;
}
function mailboxId(domain, local) { return Buffer.from(domain + "/" + local).toString("base64url"); }
function parseMailboxId(id) {
  const value = Buffer.from(String(id || ""), "base64url").toString("utf8");
  const at = value.indexOf("/");
  if (at < 1) throw new Error("Invalid mailbox.");
  return { domain: cleanDomain(value.slice(0, at)), local: cleanLocal(value.slice(at + 1)) };
}
function mailboxKey(domain, local) { return "mailboxes/" + domain + "/" + local + ".json"; }
function messagesPrefix(domain, local) { return "messages/" + domain + "/" + local + "/"; }
function attachmentPrefix(domain, local) { return "attachments/" + domain + "/" + local + "/"; }
function rawPrefix(domain, local) { return "raw/" + domain + "/" + local + "/"; }
async function listJson(prefix) {
  const keys = await store.listKeys(prefix);
  const values = [];
  for (let i = 0; i < keys.length; i += 20) {
    const batch = await Promise.all(keys.slice(i, i + 20).map(key => store.getJson(key)));
    values.push(...batch.filter(Boolean));
  }
  return values;
}
async function getMailbox(id) {
  const { domain, local } = parseMailboxId(id);
  const data = await store.getJson(mailboxKey(domain, local));
  if (!data) return null;
  return { ...data, id: mailboxId(domain, local), domain, local_part: local };
}
async function deleteMailboxData(domain, local) {
  const messageKeys = await store.listKeys(messagesPrefix(domain, local));
  for (const key of messageKeys) {
    const message = await store.getJson(key);
    if (message) {
      for (const a of message.attachments || []) if (a.key) await store.deleteKey(a.key);
      if (message.rawKey) await store.deleteKey(message.rawKey);
    }
  }
  await store.deletePrefix(messagesPrefix(domain, local));
  await store.deletePrefix(attachmentPrefix(domain, local));
  await store.deletePrefix(rawPrefix(domain, local));
}

app.get("/health", (_req, res) => res.json({ ok: true, storage: "cloudflare-r2" }));

app.post("/api/login", loginLimiter, async (req, res) => {
  const ok = await bcrypt.compare(String(req.body.password || ""), process.env.ADMIN_PASSWORD_HASH);
  if (!ok) return res.status(401).json({ error: "Incorrect password" });
  const token = jwt.sign({ role: "admin" }, process.env.SESSION_SECRET, { expiresIn: "7d" });
  res.cookie("mailbox_session", token, {
    httpOnly: true, secure: process.env.NODE_ENV === "production",
    sameSite: "strict", maxAge: 7 * 24 * 60 * 60 * 1000, path: "/"
  });
  res.json({ ok: true });
});
app.post("/api/logout", (_req, res) => { res.clearCookie("mailbox_session", { path: "/" }); res.json({ ok: true }); });
app.get("/api/me", auth, (_req, res) => res.json({ authenticated: true }));

// Cloudflare Email Worker posts the original RFC 5322 message here.
app.post("/api/inbound", express.raw({ type: "*/*", limit: "26mb" }), async (req, res) => {
  if ((req.get("authorization") || "") !== "Bearer " + process.env.INBOUND_SECRET) return res.status(401).send("Unauthorized");
  const recipient = String(req.get("x-envelope-to") || "").trim().toLowerCase();
  if (!recipient || !recipient.includes("@")) return res.status(400).send("Missing recipient");
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).send("Missing raw message");
  try {
    const address = recipient.split("@");
    const domain = cleanDomain(address.pop());
    const local = cleanLocal(address.join("@"));
    const mailbox = await store.getJson(mailboxKey(domain, local));
    if (!mailbox) return res.status(404).send("Recipient is not configured");

    const parsed = await simpleParser(req.body);
    const receivedAt = (parsed.date && !Number.isNaN(new Date(parsed.date).getTime()) ? new Date(parsed.date) : new Date()).toISOString();
    const idSeed = recipient + "|" + (parsed.messageId || crypto.randomUUID());
    const id = crypto.createHash("sha256").update(idSeed).digest("hex").slice(0, 32);
    const prefix = id;
    const attachments = [];
    for (let i = 0; i < (parsed.attachments || []).length; i++) {
      const a = parsed.attachments[i];
      const key = attachmentPrefix(domain, local) + prefix + "/" + i;
      await store.putBuffer(key, a.content, a.contentType || "application/octet-stream");
      attachments.push({
        filename: String(a.filename || "attachment").slice(0, 180),
        contentType: a.contentType || "application/octet-stream",
        size: a.size || a.content.length,
        key
      });
    }
    const rawKey = rawPrefix(domain, local) + prefix + ".eml";
    await store.putBuffer(rawKey, req.body, "message/rfc822");
    const message = {
      id, mailboxId: mailboxId(domain, local), sender: parsed.from?.text || "",
      recipient, subject: String(parsed.subject || "(no subject)").slice(0, 998),
      text_body: String(parsed.text || "").slice(0, 1000000),
      html_body: sanitizeHtml(String(parsed.html || ""), {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2", "u"]),
        allowedAttributes: { a: ["href", "name", "target"], img: ["src", "alt", "width", "height"], "*": ["style"] },
        allowedSchemes: ["http", "https", "mailto", "cid"],
        disallowedTagsMode: "discard"
      }).slice(0, 1000000),
      received_at: receivedAt, is_read: false, attachments, rawKey
    };
    await store.putJson(messagesPrefix(domain, local) + id + ".json", message);
    res.status(202).send("Accepted");
  } catch (err) {
    console.error("Inbound message processing failed:", err.message);
    res.status(500).send("Message processing failed");
  }
});

app.use("/api", apiLimiter, auth);

app.get("/api/domains", async (_req, res) => {
  const keys = await store.listKeys("domains/");
  const result = [];
  for (const key of keys) {
    const domain = await store.getJson(key);
    if (!domain) continue;
    const mailboxKeys = await store.listKeys("mailboxes/" + domain.name + "/");
    let messageCount = 0;
    for (const mk of mailboxKeys) {
      const local = mk.slice(("mailboxes/" + domain.name + "/").length).replace(/\.json$/, "");
      messageCount += (await store.listKeys(messagesPrefix(domain.name, local))).length;
    }
    result.push({ ...domain, id: domain.name, mailbox_count: mailboxKeys.length, message_count: messageCount });
  }
  result.sort((a,b) => a.name.localeCompare(b.name));
  res.json(result);
});

app.post("/api/domains", async (req, res) => {
  try {
    const name = cleanDomain(req.body.name);
    const key = "domains/" + name + ".json";
    if (await store.getJson(key)) return res.status(409).json({ error: "That domain is already added." });
    const record = { name, created_at: new Date().toISOString() };
    await store.putJson(key, record);
    res.status(201).json({ ...record, id: name });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/domains/:id", async (req, res) => {
  const domain = cleanDomain(req.params.id);
  const mailboxKeys = await store.listKeys("mailboxes/" + domain + "/");
  for (const key of mailboxKeys) {
    const local = key.slice(("mailboxes/" + domain + "/").length).replace(/\.json$/, "");
    await deleteMailboxData(domain, local);
    await store.deleteKey(key);
  }
  await store.deleteKey("domains/" + domain + ".json");
  res.json({ ok: true });
});

app.get("/api/mailboxes", async (req, res) => {
  const prefix = req.query.domain
    ? "mailboxes/" + cleanDomain(String(req.query.domain)) + "/"
    : "mailboxes/";
  const keys = await store.listKeys(prefix);
  const result = [];
  for (const key of keys) {
    const mailbox = await store.getJson(key);
    if (!mailbox) continue;
    const domain = mailbox.domain;
    const local = mailbox.local_part;
    const messages = await listJson(messagesPrefix(domain, local));
    result.push({
      id: mailboxId(domain, local), domain, local_part: local,
      message_count: messages.length,
      unread_count: messages.filter(m => !m.is_read).length
    });
  }
  result.sort((a,b) => (a.domain + a.local_part).localeCompare(b.domain + b.local_part));
  res.json(result);
});

app.post("/api/mailboxes", async (req, res) => {
  try {
    const domain = cleanDomain(String(req.body.domain || ""));
    const local = cleanLocal(req.body.localPart);
    if (!await store.getJson("domains/" + domain + ".json")) return res.status(400).json({ error: "Choose a valid domain." });
    const key = mailboxKey(domain, local);
    if (await store.getJson(key)) return res.status(409).json({ error: "That address already exists." });
    await store.putJson(key, { domain, local_part: local, created_at: new Date().toISOString() });
    res.status(201).json({ id: mailboxId(domain, local), local_part: local });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/mailboxes/bulk", async (req, res) => {
  const domain = cleanDomain(String(req.body.domain || ""));
  const start = Number(req.body.start), count = Number(req.body.count);
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 100) return res.status(400).json({ error: "Choose a start number and a batch size from 1 to 100." });
  if (!await store.getJson("domains/" + domain + ".json")) return res.status(400).json({ error: "Choose a valid domain." });
  const created = [];
  for (let n = start; n < start + count; n++) {
    const local = String(n), key = mailboxKey(domain, local);
    if (await store.getJson(key)) continue;
    await store.putJson(key, { domain, local_part: local, created_at: new Date().toISOString() });
    created.push(local);
  }
  res.status(201).json({ created, skipped: count - created.length });
});

app.delete("/api/mailboxes/:id", async (req, res) => {
  try {
    const { domain, local } = parseMailboxId(req.params.id);
    await deleteMailboxData(domain, local);
    await store.deleteKey(mailboxKey(domain, local));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/messages", async (req, res) => {
  try {
    const { domain, local } = parseMailboxId(req.query.mailbox);
    const q = String(req.query.q || "").trim().toLowerCase().slice(0, 120);
    const messages = await listJson(messagesPrefix(domain, local));
    const filtered = messages.filter(m => !q || [m.subject, m.sender, m.text_body].some(v => String(v || "").toLowerCase().includes(q)));
    filtered.sort((a,b) => new Date(b.received_at) - new Date(a.received_at));
    res.json(filtered.slice(0, 100).map(m => ({
      id: m.id, sender: m.sender, recipient: m.recipient, subject: m.subject,
      received_at: m.received_at, is_read: m.is_read,
      preview: String(m.text_body || "").slice(0, 260),
      attachment_count: (m.attachments || []).length
    })));
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/messages/:id", async (req, res) => {
  try {
    const { domain, local } = parseMailboxId(req.query.mailbox);
    const key = messagesPrefix(domain, local) + req.params.id + ".json";
    const message = await store.getJson(key);
    if (!message) return res.status(404).json({ error: "Message not found." });
    message.is_read = true;
    await store.putJson(key, message);
    res.json({ ...message, attachments: (message.attachments || []).map((a,index) => ({
      index, filename: a.filename, contentType: a.contentType, size: a.size
    })) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/messages/:id/attachments/:index", async (req, res) => {
  try {
    const { domain, local } = parseMailboxId(req.query.mailbox);
    const message = await store.getJson(messagesPrefix(domain, local) + req.params.id + ".json");
    if (!message) return res.sendStatus(404);
    const a = (message.attachments || [])[Number(req.params.index)];
    if (!a) return res.sendStatus(404);
    const data = await store.getBuffer(a.key);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(a.filename || "attachment"));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(data);
  } catch { res.sendStatus(404); }
});

app.delete("/api/messages/:id", async (req, res) => {
  try {
    const { domain, local } = parseMailboxId(req.query.mailbox);
    const key = messagesPrefix(domain, local) + req.params.id + ".json";
    const message = await store.getJson(key);
    if (!message) return res.sendStatus(404);
    for (const a of message.attachments || []) if (a.key) await store.deleteKey(a.key);
    if (message.rawKey) await store.deleteKey(message.rawKey);
    await store.deleteKey(key);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/messages/:id/read", async (req, res) => {
  try {
    const { domain, local } = parseMailboxId(req.body.mailbox);
    const key = messagesPrefix(domain, local) + req.params.id + ".json";
    const message = await store.getJson(key);
    if (!message) return res.sendStatus(404);
    message.is_read = Boolean(req.body.read);
    await store.putJson(key, message);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.use((_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, "0.0.0.0", () => console.log("Mailbox listening on port " + PORT));
