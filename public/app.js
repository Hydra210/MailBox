const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const icon = (name, cls = "") => '<svg class="ic ' + cls + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';

let domains = [], mailboxes = [], selectedDomain = null, selectedMailbox = null, selectedMessage = null, activeTab = "single";
let listToken = 0;
const narrow = window.matchMedia("(max-width:759px)");

/* ───────── Helpers ───────── */
async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
  });
  if (response.status === 401) { showLogin(); throw new Error("Please sign in again."); }
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data.error || data || "Request failed.");
  return data;
}
let toastTimer;
function toast(message) {
  const el = $("#toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
const addressOf = (m) => m.local_part + "@" + m.domain;
const safe = (fn) => async (...args) => { try { await fn(...args); } catch (err) { if (err && err.message) toast(err.message); } };

function shortDate(value) {
  const d = new Date(value); if (isNaN(d)) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = (now - d) / 864e5;
  if (days >= 0 && days < 6) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}
function fullDate(value) {
  const d = new Date(value);
  return isNaN(d) ? "" : d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
function parseSender(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
  let name, email;
  if (m) { name = m[1].trim(); email = m[2].trim(); }
  else { email = s.includes("@") ? s : ""; name = s; }
  if (!name) name = email.split("@")[0] || "Unknown sender";
  return { name, email };
}
function avatar(name, large) {
  const ch = (String(name).match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase();
  let h = 0; for (const c of String(name).toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return '<span class="avatar' + (large ? " lg" : "") + '" style="--h:' + h + '" aria-hidden="true">' + escapeHtml(ch) + "</span>";
}
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const field = document.createElement("textarea");
  field.value = text; field.style.position = "fixed"; field.style.opacity = "0";
  document.body.appendChild(field); field.select();
  const copied = document.execCommand("copy"); field.remove();
  if (!copied) throw new Error("Clipboard unavailable");
}

/* ───────── Views: login, app, drawer, theme ───────── */
function showLogin() { closeDrawer(); $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); }
function showApp() { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); }
function openDrawer() {
  $("#sidebar").classList.add("open"); $("#drawer-backdrop").classList.add("show");
  $("#menu-toggle").setAttribute("aria-expanded", "true"); document.body.classList.add("no-scroll");
}
function closeDrawer() {
  $("#sidebar").classList.remove("open"); $("#drawer-backdrop").classList.remove("show");
  $("#menu-toggle").setAttribute("aria-expanded", "false"); document.body.classList.remove("no-scroll");
}
function applyThemeIcon() {
  const light = document.documentElement.getAttribute("data-theme") === "light";
  $("#theme-toggle").innerHTML = icon(light ? "moon" : "sun");
  $("#theme-toggle").setAttribute("aria-label", light ? "Switch to dark theme" : "Switch to light theme");
}
$("#theme-toggle").onclick = () => {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("mailbox-theme", next); } catch {}
  $("#theme-color").setAttribute("content", next === "light" ? "#f3f4f7" : "#0b0c0f");
  applyThemeIcon();
};
applyThemeIcon();
$("#menu-toggle").onclick = openDrawer;
$("#drawer-close").onclick = closeDrawer;
$("#drawer-backdrop").onclick = closeDrawer;
document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
  if ($("#sidebar").classList.contains("open")) closeDrawer();
  else if (narrow.matches && $("#inbox-view").classList.contains("reading")) backToList();
});
$("#pw-toggle").onclick = () => {
  const input = $("#password"), show = input.type === "password";
  input.type = show ? "text" : "password";
  $("#pw-toggle").setAttribute("aria-label", show ? "Hide password" : "Show password");
};

/* ───────── Data loading ───────── */
async function boot() {
  try { await api("/api/me"); showApp(); await loadDomains(); }
  catch { showLogin(); }
}
async function loadDomains() {
  domains = await api("/api/domains");
  if (selectedDomain && !domains.some(d => d.id === selectedDomain)) selectedDomain = null;
  renderDomains();
  await loadMailboxes();
}
const mailboxQuery = () => selectedDomain ? "?domain=" + encodeURIComponent(selectedDomain) : "";
async function loadMailboxes() {
  mailboxes = await api("/api/mailboxes" + mailboxQuery());
  if (selectedMailbox && !mailboxes.some(m => m.id === selectedMailbox)) { selectedMailbox = null; selectedMessage = null; }
  renderMailboxes();
  if (selectedMailbox) await loadMessages(); else showEmpty();
}
async function refreshCounts() {
  mailboxes = await api("/api/mailboxes" + mailboxQuery());
  renderMailboxes(); updateHeader();
}

/* ───────── Sidebar ───────── */
function renderDomains() {
  const total = domains.reduce((n, d) => n + (d.mailbox_count || 0), 0);
  const item = (id, name, count, active) =>
    '<button class="domain-item' + (active ? " active" : "") + '" data-domain="' + escapeHtml(id) + '" aria-pressed="' + active + '">' +
    icon("globe") + '<span class="name">' + escapeHtml(name) + '</span><span class="count-pill">' + count + "</span></button>";
  $("#domain-list").innerHTML = domains.length
    ? item("", "All domains", total, !selectedDomain) + domains.map(d => item(d.id, d.name, d.mailbox_count || 0, selectedDomain === d.id)).join("")
    : '<p class="side-empty">No domains yet. Add one to get started.</p>';
  $("#mailbox-domain").innerHTML = domains.map(d => '<option value="' + escapeHtml(d.name) + '">' + escapeHtml(d.name) + "</option>").join("");
}
function renderMailboxes() {
  const q = $("#mailbox-filter").value.trim().toLowerCase();
  const list = mailboxes.filter(m => !q || addressOf(m).toLowerCase().includes(q));
  $("#mailbox-list").innerHTML = list.map(m => {
    const address = addressOf(m);
    return '<div class="mbx' + (selectedMailbox === m.id ? " active" : "") + (m.unread_count ? " has-unread" : "") + '">' +
      '<button class="mbx-main" data-mailbox="' + escapeHtml(m.id) + '" title="' + escapeHtml(address) + '">' + icon("mail") +
      '<span class="mbx-name"><b>' + escapeHtml(m.local_part) + "</b>@" + escapeHtml(m.domain) + "</span>" +
      (m.unread_count ? '<span class="count-pill unread">' + m.unread_count + "</span>" : "") + "</button>" +
      '<button class="mbx-copy" data-copy-address="' + escapeHtml(address) + '" aria-label="Copy ' + escapeHtml(address) + '" title="Copy address">' + icon("copy") + "</button></div>";
  }).join("") || '<p class="side-empty">' + (q ? "No inboxes match “" + escapeHtml($("#mailbox-filter").value.trim()) + "”." : "No inboxes yet. Create one to start receiving mail.") + "</p>";
}
$("#domain-list").addEventListener("click", safe(async e => {
  const btn = e.target.closest("[data-domain]"); if (!btn) return;
  selectedDomain = btn.dataset.domain || null; selectedMailbox = null; selectedMessage = null;
  renderDomains(); await loadMailboxes();
}));
$("#mailbox-list").addEventListener("click", safe(async e => {
  const copy = e.target.closest("[data-copy-address]");
  if (copy) {
    const address = copy.dataset.copyAddress;
    try { await copyText(address); toast("Copied " + address); } catch { toast("Couldn't copy address"); }
    return;
  }
  const btn = e.target.closest("[data-mailbox]"); if (!btn) return;
  await selectMailbox(btn.dataset.mailbox);
}));
async function selectMailbox(id) {
  selectedMailbox = id; selectedMessage = null; $("#search").value = "";
  renderMailboxes(); closeDrawer();
  await loadMessages();
}
$("#mailbox-filter").addEventListener("input", renderMailboxes);

/* ───────── Header + overview ───────── */
function updateHeader() {
  const mb = mailboxes.find(m => m.id === selectedMailbox);
  $("#search-box").classList.toggle("hidden", !mb);
  if (mb) {
    $("#current-title").textContent = addressOf(mb);
    $("#current-sub").textContent = mb.unread_count ? plural(mb.unread_count, "unread message", "unread messages") : "All caught up";
  } else {
    const unread = mailboxes.reduce((n, m) => n + (m.unread_count || 0), 0);
    $("#current-title").textContent = "Overview";
    $("#current-sub").textContent = domains.length
      ? plural(domains.length, "domain", "domains") + ", " + plural(mailboxes.length, "inbox", "inboxes") + (unread ? ", " + unread + " unread" : "")
      : "";
  }
}
function showEmpty() {
  $("#inbox-view").classList.add("hidden"); $("#inbox-view").classList.remove("reading");
  $("#empty-state").classList.remove("hidden");
  updateHeader();
  const el = $("#empty-content");
  if (!domains.length) {
    el.innerHTML = '<div class="empty-icon">' + icon("globe") + "</div><h2>Add your first domain</h2><p>Connect a domain you manage in Cloudflare, then create inboxes for it.</p>" +
      '<button class="primary" id="empty-add-domain" type="button">' + icon("plus") + "Add domain</button>";
  } else if (!mailboxes.length) {
    el.innerHTML = '<div class="empty-icon">' + icon("mail") + "</div><h2>No inboxes yet</h2><p>Create an address, then point its Cloudflare email route at this app.</p>" +
      '<button class="primary" id="empty-add-mailbox" type="button">' + icon("plus") + "New inbox</button>";
  } else {
    const unread = mailboxes.filter(m => m.unread_count).sort((a, b) => b.unread_count - a.unread_count).slice(0, 8);
    el.innerHTML = '<div class="empty-icon">' + icon("mail") + "</div><h2>" + (unread.length ? "You have new mail" : "All caught up") + "</h2>" +
      "<p>" + (unread.length ? "Pick an inbox to read it." : "Choose an inbox from the sidebar to read its messages.") + "</p>" +
      '<button class="secondary only-drawer-inline" id="empty-open-menu" type="button">Browse inboxes</button>' +
      (unread.length ? '<div class="attention"><h3>Unread</h3><div class="attention-list">' + unread.map(m =>
        '<button class="attention-item" data-open-mailbox="' + escapeHtml(m.id) + '" type="button">' + icon("mail") +
        '<span class="addr">' + escapeHtml(addressOf(m)) + '</span><span class="count-pill unread">' + m.unread_count + "</span></button>").join("") + "</div></div>" : "");
  }
}
$("#empty-content").addEventListener("click", safe(async e => {
  if (e.target.closest("#empty-add-domain")) return openDomainDialog();
  if (e.target.closest("#empty-add-mailbox")) return openMailboxDialog();
  if (e.target.closest("#empty-open-menu")) return openDrawer();
  const btn = e.target.closest("[data-open-mailbox]");
  if (btn) await selectMailbox(btn.dataset.openMailbox);
}));

/* ───────── Message list ───────── */
const fetchMessages = () => api("/api/messages?mailbox=" + encodeURIComponent(selectedMailbox) + "&q=" + encodeURIComponent($("#search").value.trim()));
const placeholderHtml = '<div class="placeholder">' + icon("mail") + "<p>Select a message to read it.</p></div>";
function renderMessageList(messages) {
  const mb = mailboxes.find(m => m.id === selectedMailbox);
  const q = $("#search").value.trim();
  $("#message-count").textContent = plural(messages.length, "message", "messages");
  $("#message-list").innerHTML = messages.map(m => {
    const s = parseSender(m.sender);
    return '<button class="message-row' + (!m.is_read ? " unread" : "") + (selectedMessage === m.id ? " active" : "") + '" data-message="' + escapeHtml(m.id) + '">' +
      avatar(s.name) + '<div class="row-body"><div class="sender-line"><span class="sender">' + escapeHtml(s.name) + '</span><span class="date">' + shortDate(m.received_at) + "</span></div>" +
      '<div class="subject">' + (m.attachment_count ? icon("clip") : "") + "<span>" + escapeHtml(m.subject || "(no subject)") + "</span></div>" +
      '<div class="preview">' + escapeHtml((m.preview || "").replace(/\s+/g, " ").trim() || "No preview") + "</div></div></button>";
  }).join("") || '<div class="list-note"><b>' + (q ? "No matches" : "Nothing here yet") + "</b>" +
    (q ? "No messages match “" + escapeHtml(q) + "”." : "Mail sent to " + escapeHtml(mb ? addressOf(mb) : "this inbox") + " will show up here.") + "</div>";
}
async function loadMessages() {
  const mailbox = mailboxes.find(m => m.id === selectedMailbox);
  if (!mailbox) return;
  const token = ++listToken;
  updateHeader();
  $("#empty-state").classList.add("hidden"); $("#inbox-view").classList.remove("hidden");
  if (!selectedMessage) $("#inbox-view").classList.remove("reading");
  if (!$("#message-list").querySelector(".message-row")) {
    $("#message-list").innerHTML = Array(5).fill('<div class="sk-row"><div class="sk-av"></div><div class="sk-body"><div class="sk-line" style="width:40%"></div><div class="sk-line" style="width:75%"></div><div class="sk-line" style="width:90%"></div></div></div>').join("");
  }
  const messages = await fetchMessages();
  if (token !== listToken) return;
  renderMessageList(messages);
  if (!selectedMessage) $("#message-panel").innerHTML = placeholderHtml;
}
$("#message-list").addEventListener("click", safe(async e => {
  const btn = e.target.closest("[data-message]"); if (btn) await openMessage(btn.dataset.message);
}));
function backToList() { $("#inbox-view").classList.remove("reading"); }

/* ───────── Reader ───────── */
function renderEmailHtml(html) {
  const safeDocument = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: cid:; style-src \'unsafe-inline\'; font-src data:; media-src data:; form-action \'none\'; base-uri \'none\'"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' + html + "</body></html>";
  return '<iframe class="email-frame" sandbox="" referrerpolicy="no-referrer" title="Email content" srcdoc="' + escapeHtml(safeDocument) + '"></iframe>';
}
function formatSize(n) {
  if (!n) return "";
  return n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB";
}
async function openMessage(id) {
  selectedMessage = id;
  const mailbox = encodeURIComponent(selectedMailbox);
  const m = await api("/api/messages/" + encodeURIComponent(id) + "?mailbox=" + mailbox);
  const s = parseSender(m.sender);
  const attachments = (m.attachments || []).map(a =>
    '<a class="attachment" href="/api/messages/' + encodeURIComponent(id) + "/attachments/" + a.index + "?mailbox=" + mailbox + '">' + icon("clip") +
    "<span>" + escapeHtml(a.filename || "Attachment") + "</span>" + (a.size ? "<small>" + formatSize(a.size) + "</small>" : "") + "</a>").join("");
  const hasHtml = !!m.html_body;
  $("#message-panel").innerHTML =
    '<article class="reader"><div class="reader-head">' +
    '<button class="back-btn" id="back-to-messages" type="button">' + icon("back") + "Messages</button>" +
    "<h2>" + escapeHtml(m.subject || "(no subject)") + "</h2>" +
    '<div class="sender-card">' + avatar(s.name, true) + '<div class="sc-text"><div class="sc-name">' + escapeHtml(s.name) +
    (s.email && s.email !== s.name ? '<span class="sc-email">' + escapeHtml(s.email) + "</span>" : "") + '</div><div class="sc-to">to ' + escapeHtml(m.recipient) + "</div></div>" +
    '<time class="sc-date">' + escapeHtml(fullDate(m.received_at)) + "</time></div>" +
    '<div class="reader-actions"><button class="btn-ghost danger" id="delete-message" type="button">' + icon("trash") + "<span>Delete</span></button>" +
    '<button class="btn-ghost" id="unread-message" type="button">' + icon("dot") + "<span>Mark unread</span></button>" +
    '<button class="btn-ghost" id="refresh-message" type="button">' + icon("refresh") + "<span>Reload</span></button></div></div>" +
    (attachments ? '<div class="attachments">' + attachments + "</div>" : "") +
    (hasHtml ? '<div class="email-view-tools"><div class="seg" role="group" aria-label="Email view"><button class="active" id="email-rendered" type="button">Email</button><button id="email-plain" type="button">Plain text</button><button id="email-source" type="button">HTML source</button></div><span class="email-safety-note">Scripts and remote content are blocked</span></div>' : "") +
    '</article>';
  // Body lives in its own scroll area under the header.
  const reader = $("#message-panel .reader");
  const body = document.createElement("div");
  body.className = "reader-body";
  body.innerHTML = '<div class="message-body" id="email-content">' +
    (hasHtml ? renderEmailHtml(m.html_body) : (m.text_body ? '<pre class="plain-email">' + escapeHtml(m.text_body) + "</pre>" : '<p class="muted">No message content.</p>')) + "</div>";
  reader.appendChild(body);

  const emailContent = $("#email-content");
  const modeButtons = ["#email-rendered", "#email-plain", "#email-source"].map(sel => $(sel)).filter(Boolean);
  function setEmailMode(mode) {
    modeButtons.forEach(b => b.classList.toggle("active", b.id === "email-" + mode));
    if (mode === "rendered") emailContent.innerHTML = renderEmailHtml(m.html_body);
    else if (mode === "plain") emailContent.innerHTML = '<pre class="plain-email">' + escapeHtml(m.text_body || "No plain-text version was included.") + "</pre>";
    else emailContent.innerHTML = '<pre class="html-source">' + escapeHtml(m.html_body || "") + "</pre>";
  }
  if (hasHtml) { $("#email-rendered").onclick = () => setEmailMode("rendered"); $("#email-plain").onclick = () => setEmailMode("plain"); $("#email-source").onclick = () => setEmailMode("source"); }
  $("#back-to-messages").onclick = backToList;
  $("#refresh-message").onclick = safe(() => openMessage(id));

  const del = $("#delete-message"); let armTimer;
  const disarm = () => { del.classList.remove("armed"); del.querySelector("span").textContent = "Delete"; };
  del.onclick = safe(async () => {
    if (!del.classList.contains("armed")) {
      del.classList.add("armed"); del.querySelector("span").textContent = "Confirm delete";
      armTimer = setTimeout(disarm, 3000); return;
    }
    clearTimeout(armTimer);
    await api("/api/messages/" + encodeURIComponent(id) + "?mailbox=" + mailbox, { method: "DELETE" });
    selectedMessage = null; await loadMessages(); await refreshCounts(); toast("Message deleted");
  });
  $("#unread-message").onclick = safe(async () => {
    await api("/api/messages/" + encodeURIComponent(id) + "/read", { method: "POST", body: JSON.stringify({ mailbox: selectedMailbox, read: false }) });
    selectedMessage = null; backToList(); await loadMessages(); await refreshCounts(); toast("Marked as unread");
  });

  $("#inbox-view").classList.add("reading");
  const scroller = narrow.matches ? reader : body; scroller.scrollTop = 0;
  // Opening marks the message read: refresh the list and unread counts once.
  try { renderMessageList(await fetchMessages()); await refreshCounts(); } catch {}
}

/* ───────── Actions: login, dialogs, refresh, search ───────── */
$("#login-form").addEventListener("submit", async e => {
  e.preventDefault(); $("#login-error").textContent = "";
  try { await api("/api/login", { method: "POST", body: JSON.stringify({ password: $("#password").value }) }); $("#password").value = ""; showApp(); await loadDomains(); }
  catch (err) { $("#login-error").textContent = err.message; }
});
$("#logout").onclick = safe(async () => { await api("/api/logout", { method: "POST" }); selectedMailbox = null; selectedMessage = null; showLogin(); });

$$("[data-close]").forEach(btn => btn.onclick = () => btn.closest("dialog").close());
$$("dialog").forEach(dlg => dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); }));

function openDomainDialog() { closeDrawer(); $("#domain-error").textContent = ""; $("#domain-dialog").showModal(); setTimeout(() => $("#domain-name").focus(), 30); }
function openMailboxDialog() {
  if (!domains.length) { toast("Add a domain first"); return; }
  closeDrawer(); $("#mailbox-error").textContent = ""; $("#mailbox-domain").value = selectedDomain || domains[0].name;
  $("#mailbox-dialog").showModal();
}
$("#add-domain").onclick = openDomainDialog;
$("#add-mailbox").onclick = openMailboxDialog;
$("#fab").onclick = openMailboxDialog;

$("#domain-form").addEventListener("submit", async e => {
  e.preventDefault();
  try { await api("/api/domains", { method: "POST", body: JSON.stringify({ name: $("#domain-name").value }) }); $("#domain-dialog").close(); $("#domain-name").value = ""; await loadDomains(); toast("Domain added"); }
  catch (err) { $("#domain-error").textContent = err.message; }
});
$$("[data-tab]").forEach(btn => btn.onclick = () => {
  activeTab = btn.dataset.tab;
  $$("[data-tab]").forEach(b => b.classList.toggle("active", b === btn));
  $("#single-fields").classList.toggle("hidden", activeTab !== "single");
  $("#bulk-fields").classList.toggle("hidden", activeTab !== "bulk");
});
$("#mailbox-form").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const domain = $("#mailbox-domain").value;
    if (activeTab === "single") {
      await api("/api/mailboxes", { method: "POST", body: JSON.stringify({ domain, localPart: $("#local-part").value }) });
      toast("Inbox created");
    } else {
      const result = await api("/api/mailboxes/bulk", { method: "POST", body: JSON.stringify({ domain, start: Number($("#bulk-start").value), count: Number($("#bulk-count").value) }) });
      toast("Created " + plural(result.created.length, "inbox", "inboxes") + (result.skipped ? ", skipped " + result.skipped : ""));
    }
    selectedDomain = domain; selectedMailbox = null; selectedMessage = null; $("#mailbox-dialog").close(); $("#local-part").value = ""; await loadDomains();
  } catch (err) { $("#mailbox-error").textContent = err.message; }
});
$("#refresh").onclick = safe(async () => {
  const btn = $("#refresh"); btn.disabled = true;
  try { await loadDomains(); toast("Refreshed"); } finally { btn.disabled = false; }
});
let searchTimer;
$("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(safe(async () => { if (selectedMailbox) { selectedMessage = null; backToList(); await loadMessages(); } }), 250);
});

boot();

/* ───────── GroqCloud signup assistant ─────────
   One address at a time, with user-controlled submission. */
const GROQ_SIGNUP_URL = "https://console.groq.com/login";
let groqQueue = [], groqAvailableMailboxes = [], groqIndex = 0, groqBatchActive = false;
function renderGroqOptions() {
  const list = $("#groq-mailbox-options");
  list.innerHTML = groqAvailableMailboxes.map(m =>
    '<label class="groq-option"><input type="checkbox" class="groq-choice" value="' + escapeHtml(m.id) + '" checked><span>' + escapeHtml(addressOf(m)) + "</span></label>"
  ).join("") || '<p class="muted">No inboxes available.</p>';
  list.querySelectorAll(".groq-choice").forEach(input => input.addEventListener("change", updateGroqSelection));
  $("#groq-select-all").checked = groqAvailableMailboxes.length > 0;
  updateGroqSelection();
}
function updateGroqSelection() {
  const choices = $$(".groq-choice");
  const selected = choices.filter(c => c.checked).length;
  $("#groq-selected-count").textContent = selected + " selected";
  $("#groq-select-all").checked = choices.length > 0 && selected === choices.length;
  $("#groq-select-all").indeterminate = selected > 0 && selected < choices.length;
}
$("#groq-select-all").addEventListener("change", () => {
  $$(".groq-choice").forEach(c => c.checked = $("#groq-select-all").checked);
  updateGroqSelection();
});
$("#groq-batch").addEventListener("click", safe(async () => {
  groqAvailableMailboxes = await api("/api/mailboxes");
  renderGroqOptions();
  groqQueue = []; groqIndex = 0; groqBatchActive = false;
  $("#groq-progress").classList.add("hidden");
  $("#groq-start").classList.remove("hidden"); $("#groq-start").textContent = "Start batch";
  $("#groq-next").classList.add("hidden");
  $("#groq-note").textContent = "This assistant does not submit registrations or bypass verification. You complete each signup manually.";
  closeDrawer(); $("#groq-dialog").showModal();
}));
function launchGroqStep() {
  const m = groqQueue[groqIndex];
  if (!m) return;
  const address = addressOf(m);
  const tab = window.open(GROQ_SIGNUP_URL, "_blank", "noopener");
  copyText(address).then(() => toast("Copied " + address)).catch(() => toast("Copy this address: " + address));
  $("#groq-progress").textContent = "Address " + (groqIndex + 1) + " of " + groqQueue.length + ": " + address;
  $("#groq-progress").classList.remove("hidden");
  $("#groq-start").classList.add("hidden");
  $("#groq-next").classList.remove("hidden");
  $("#groq-next").textContent = groqIndex + 1 >= groqQueue.length ? "Finish batch" : "Next address";
  if (!tab) $("#groq-note").textContent = "Your browser blocked the new tab. Allow pop-ups for Mailbox, then press Next address to continue.";
}
$("#groq-start").addEventListener("click", () => {
  const ids = $$(".groq-choice:checked").map(c => c.value);
  groqQueue = ids.map(id => groqAvailableMailboxes.find(m => m.id === id)).filter(Boolean);
  if (!groqQueue.length) { toast("Select at least one inbox"); return; }
  groqIndex = 0; groqBatchActive = true; launchGroqStep();
});
$("#groq-next").addEventListener("click", () => {
  if (!groqBatchActive) return;
  groqIndex++;
  if (groqIndex >= groqQueue.length) {
    groqBatchActive = false;
    $("#groq-progress").textContent = "Batch complete: " + plural(groqQueue.length, "address", "addresses") + " processed.";
    $("#groq-next").classList.add("hidden");
    $("#groq-start").classList.remove("hidden");
    $("#groq-start").textContent = "Start another batch";
    $("#groq-note").textContent = "Check Mailbox for verification emails. Each account's signup and verification must be completed according to GroqCloud's requirements.";
    toast("Batch complete");
    return;
  }
  launchGroqStep();
});
