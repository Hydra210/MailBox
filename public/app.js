const $ = (s) => document.querySelector(s);
let domains = [], mailboxes = [], selectedDomain = null, selectedMailbox = null, selectedMessage = null, activeTab = "single";

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
function toast(message) {
  const el = $("#toast"); el.textContent = message; el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}
function showLogin() { $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); }
function showApp() { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); }
function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function niceDate(value) { const d = new Date(value); return isNaN(d) ? "" : d.toLocaleString([], { month:"short", day:"numeric", hour:"numeric", minute:"2-digit" }); }

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
function renderDomains() {
  $("#domain-list").innerHTML = domains.map(d =>
    '<button class="domain-item ' + (selectedDomain === d.id ? "active" : "") + '" data-domain="' + d.id + '"><span>⌁ ' + escapeHtml(d.name) + '</span><span class="count">' + d.mailbox_count + '</span></button>'
  ).join("");
  $("#mailbox-domain").innerHTML = domains.map(d => '<option value="' + escapeHtml(d.name) + '">' + escapeHtml(d.name) + '</option>').join("");
  $("#domain-list").querySelectorAll("[data-domain]").forEach(btn => btn.onclick = async () => {
    selectedDomain = btn.dataset.domain; selectedMailbox = null; selectedMessage = null;
    renderDomains(); await loadMailboxes();
  });
}
async function loadMailboxes() {
  const suffix = selectedDomain ? "?domain=" + encodeURIComponent(selectedDomain) : "";
  mailboxes = await api("/api/mailboxes" + suffix);
  renderMailboxes();
  if (selectedMailbox && !mailboxes.some(m => m.id === selectedMailbox)) selectedMailbox = null;
  if (selectedMailbox) await loadMessages();
  else { $("#inbox-view").classList.add("hidden"); $("#empty-state").classList.remove("hidden"); }
}
function renderMailboxes() {
  $("#mailbox-list").innerHTML = mailboxes.map(m =>
    '<button class="mailbox-item ' + (selectedMailbox === m.id ? "active" : "") + '" data-mailbox="' + m.id + '"><span>✉ ' + escapeHtml(m.local_part + "@" + m.domain) + '</span><span class="count">' + (m.unread_count || "") + '</span></button>'
  ).join("");
  $("#mailbox-list").querySelectorAll("[data-mailbox]").forEach(btn => btn.onclick = async () => {
    selectedMailbox = btn.dataset.mailbox; selectedMessage = null;
    renderMailboxes(); await loadMessages();
  });
}
async function loadMessages() {
  const mailbox = mailboxes.find(m => m.id === selectedMailbox);
  if (!mailbox) return;
  $("#current-title").textContent = mailbox.local_part + "@" + mailbox.domain;
  $("#empty-state").classList.add("hidden"); $("#inbox-view").classList.remove("hidden");
  if (!selectedMessage) $("#inbox-view").classList.remove("reading");
  const q = $("#search").value.trim();
  const messages = await api("/api/messages?mailbox=" + encodeURIComponent(selectedMailbox) + "&q=" + encodeURIComponent(q));
  $("#message-count").textContent = messages.length + (messages.length === 1 ? " message" : " messages");
  $("#message-list").innerHTML = messages.map(m =>
    '<button class="message-row ' + (!m.is_read ? "unread " : "") + (selectedMessage === m.id ? "active" : "") + '" data-message="' + m.id + '">' +
    '<div class="sender-line"><span class="sender">' + escapeHtml(m.sender || "Unknown sender") + '</span><span class="date">' + niceDate(m.received_at) + '</span></div>' +
    '<div class="subject">' + escapeHtml(m.subject) + '</div><div class="preview">' + escapeHtml(m.preview || "No preview") + '</div></button>'
  ).join("") || '<div class="message-placeholder">No messages yet.</div>';
  $("#message-list").querySelectorAll("[data-message]").forEach(btn => btn.onclick = () => openMessage(Number(btn.dataset.message)));
  if (!selectedMessage) $("#message-panel").innerHTML = '<div class="message-placeholder">Select a message to read it.</div>';
}
async function openMessage(id) {
  selectedMessage = id;
  const m = await api("/api/messages/" + id + "?mailbox=" + encodeURIComponent(selectedMailbox));
  $("#message-panel").innerHTML =
    '<div class="message-head"><button class="mobile-back" id="back-to-messages">← All messages</button><h2>' + escapeHtml(m.subject) + '</h2>' +
    '<p class="meta">From: ' + escapeHtml(m.sender) + '</p><p class="meta">To: ' + escapeHtml(m.recipient) + '</p><p class="meta">' + niceDate(m.received_at) + '</p>' +
    '<div class="message-actions"><button class="tiny-button" id="delete-message">Delete</button><button class="tiny-button" id="refresh-message">Refresh</button></div></div>' +
    '<div class="attachments">' + (m.attachments || []).map(a => '<a class="attachment" href="/api/messages/' + id + '/attachments/' + a.index + '?mailbox=' + encodeURIComponent(selectedMailbox) + '">↓ ' + escapeHtml(a.filename) + '</a>').join("") + '</div>' +
    '<div class="message-body">' + (m.text_body ? escapeHtml(m.text_body) : (m.html_body ? '<iframe sandbox="" referrerpolicy="no-referrer" title="Email content" srcdoc="' + escapeHtml(m.html_body) + '"></iframe>' : "No message content.")) + '</div>';
  const backButton = $("#back-to-messages");
  if (backButton) backButton.onclick = () => $("#inbox-view").classList.remove("reading");
  $("#inbox-view").classList.add("reading");
  $("#delete-message").onclick = async () => { await api("/api/messages/" + id + "?mailbox=" + encodeURIComponent(selectedMailbox), { method:"DELETE" }); selectedMessage = null; await loadMessages(); toast("Message deleted"); };
  $("#refresh-message").onclick = () => openMessage(id);
  await loadMessagesKeepMessage();
}
async function loadMessagesKeepMessage() {
  const q = $("#search").value.trim();
  const messages = await api("/api/messages?mailbox=" + encodeURIComponent(selectedMailbox) + "&q=" + encodeURIComponent(q));
  $("#message-count").textContent = messages.length + (messages.length === 1 ? " message" : " messages");
  $("#message-list").innerHTML = messages.map(m =>
    '<button class="message-row ' + (!m.is_read ? "unread " : "") + (selectedMessage === m.id ? "active" : "") + '" data-message="' + m.id + '">' +
    '<div class="sender-line"><span class="sender">' + escapeHtml(m.sender || "Unknown sender") + '</span><span class="date">' + niceDate(m.received_at) + '</span></div>' +
    '<div class="subject">' + escapeHtml(m.subject) + '</div><div class="preview">' + escapeHtml(m.preview || "No preview") + '</div></button>'
  ).join("") || '<div class="message-placeholder">No messages yet.</div>';
  $("#message-list").querySelectorAll("[data-message]").forEach(btn => btn.onclick = () => openMessage(Number(btn.dataset.message)));
  await loadMailboxes();
}
$("#login-form").addEventListener("submit", async e => {
  e.preventDefault(); $("#login-error").textContent = "";
  try { await api("/api/login", { method:"POST", body:JSON.stringify({ password:$("#password").value }) }); $("#password").value = ""; showApp(); await loadDomains(); }
  catch (err) { $("#login-error").textContent = err.message; }
});
$("#logout").onclick = async () => { await api("/api/logout", { method:"POST" }); showLogin(); };
$("#add-domain").onclick = () => { $("#domain-error").textContent = ""; $("#domain-dialog").showModal(); };
$("#domain-form").addEventListener("submit", async e => {
  e.preventDefault();
  try { await api("/api/domains", { method:"POST", body:JSON.stringify({ name:$("#domain-name").value }) }); $("#domain-dialog").close(); $("#domain-name").value = ""; await loadDomains(); toast("Domain added"); }
  catch (err) { $("#domain-error").textContent = err.message; }
});
$("#add-mailbox").onclick = () => {
  if (!domains.length) { toast("Add a domain first"); return; }
  $("#mailbox-error").textContent = ""; $("#mailbox-domain").value = selectedDomain || domains[0].name;
  $("#mailbox-dialog").showModal();
};
document.querySelectorAll("[data-tab]").forEach(btn => btn.onclick = () => {
  activeTab = btn.dataset.tab;
  document.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("active", b === btn));
  $("#single-fields").classList.toggle("hidden", activeTab !== "single");
  $("#bulk-fields").classList.toggle("hidden", activeTab !== "bulk");
});
$("#mailbox-form").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const domain = $("#mailbox-domain").value;
    if (activeTab === "single") {
      await api("/api/mailboxes", { method:"POST", body:JSON.stringify({ domain, localPart:$("#local-part").value }) });
    } else {
      const result = await api("/api/mailboxes/bulk", { method:"POST", body:JSON.stringify({ domain, start:Number($("#bulk-start").value), count:Number($("#bulk-count").value) }) });
      toast("Created " + result.created.length + " inboxes · skipped " + result.skipped);
    }
    selectedDomain = domain; selectedMailbox = null; $("#mailbox-dialog").close(); await loadDomains(); toast("Inbox list updated");
  } catch (err) { $("#mailbox-error").textContent = err.message; }
});
$("#refresh").onclick = async () => { await loadDomains(); toast("Inbox refreshed"); };
let searchTimer;
$("#search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { if (selectedMailbox) { selectedMessage = null; loadMessages(); } }, 250); });
boot();

$("#mobile-add-domain").onclick = () => $("#add-domain").click();
$("#mobile-add-mailbox").onclick = () => $("#add-mailbox").click();
$("#mobile-logout").onclick = () => $("#logout").click();
