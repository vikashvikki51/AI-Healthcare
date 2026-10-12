const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("medfusion_token") || "";
let user = null;
let authMode = "login";
let reminders = [];

function setMessage(id, text, isError = false) {
  const el = $(id); el.textContent = text || ""; el.style.color = isError ? "#b42318" : "#087e78";
}
async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
function showApp(signedIn) {
  $("authPanel").classList.toggle("hidden", signedIn);
  $("appPanel").classList.toggle("hidden", !signedIn);
  $("logoutBtn").classList.toggle("hidden", !signedIn);
}
function chooseAuth(mode) {
  authMode = mode;
  $("loginTab").classList.toggle("active", mode === "login");
  $("registerTab").classList.toggle("active", mode === "register");
  $("nameWrap").classList.toggle("hidden", mode !== "register");
  $("authSubmit").textContent = mode === "login" ? "Sign in" : "Create account";
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
  setMessage("authMessage", "");
}
$("loginTab").addEventListener("click", () => chooseAuth("login"));
$("registerTab").addEventListener("click", () => chooseAuth("register"));
$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setMessage("authMessage", "Please wait…");
  try {
    const body = { email: $("email").value, password: $("password").value };
    if (authMode === "register") body.name = $("name").value;
    const data = await api(`/api/auth/${authMode === "login" ? "login" : "register"}`, { method: "POST", body: JSON.stringify(body) });
    token = data.token; user = data.user; sessionStorage.setItem("medfusion_token", token);
    await enterApp();
  } catch (err) { setMessage("authMessage", err.message, true); }
});
$("logoutBtn").addEventListener("click", () => {
  token = ""; user = null; sessionStorage.removeItem("medfusion_token"); showApp(false);
});
async function enterApp() {
  try {
    const data = await api("/api/me"); user = data.user;
    $("userName").textContent = user.name;
    showApp(true);
    const today = new Date().toLocaleDateString("en-CA");
    $("appointmentDate").min = today; $("appointmentDate").value = today;
    $("queueDate").value = today;
    await Promise.all([loadAppointments(), loadQueue(), loadReminders()]);
  } catch { token = ""; sessionStorage.removeItem("medfusion_token"); showApp(false); }
}
$("appointmentForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setMessage("appointmentMessage", "Booking…");
  try {
    const data = await api("/api/appointments", { method: "POST", body: JSON.stringify({ appointmentDate: $("appointmentDate").value, reason: $("reason").value }) });
    setMessage("appointmentMessage", `Appointment booked. Your token is ${data.appointment.token_number}.`);
    $("reason").value = ""; $("queueDate").value = data.appointment.appointment_date;
    await Promise.all([loadAppointments(), loadQueue()]);
  } catch (err) { setMessage("appointmentMessage", err.message, true); }
});
function safeText(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c])); }
async function loadAppointments() {
  const data = await api("/api/appointments");
  const list = $("appointmentsList");
  if (!data.appointments.length) { list.className = "empty"; list.textContent = "No appointments yet. Book one above."; return; }
  list.className = "";
  list.innerHTML = data.appointments.map(a => `<div class="item"><div><strong>Token #${a.token_number} · ${safeText(a.appointment_date)}</strong><small>${safeText(a.reason)}<br>Created: ${safeText(a.created_at)}</small></div><span class="status">${safeText(a.status)}</span></div>`).join("");
}
$("refreshAppointments").addEventListener("click", () => loadAppointments().catch(e => alert(e.message)));
async function loadQueue() {
  const date = $("queueDate").value;
  if (!date) return;
  try {
    const q = await api(`/api/queue/${encodeURIComponent(date)}`);
    $("nextToken").textContent = q.nextToken ?? "—";
    setMessage("queueMessage", `${q.waitingCount} patient(s) waiting${q.currentToken ? ` · In consultation: #${q.currentToken}` : ""}.`);
  } catch (err) { setMessage("queueMessage", err.message, true); }
}
$("refreshQueue").addEventListener("click", loadQueue);
$("queueDate").addEventListener("change", loadQueue);
$("reminderForm").addEventListener("submit", async (e) => {
  e.preventDefault(); setMessage("reminderMessage", "Saving…");
  try {
    await api("/api/reminders", { method: "POST", body: JSON.stringify({ medicineName: $("medicineName").value, instructions: $("instructions").value, reminderTime: $("reminderTime").value }) });
    $("medicineName").value = ""; $("instructions").value = "";
    setMessage("reminderMessage", "Reminder saved. Keep following your clinician's prescription.");
    await loadReminders();
  } catch (err) { setMessage("reminderMessage", err.message, true); }
});
async function loadReminders() {
  const data = await api("/api/reminders"); reminders = data.reminders;
  const list = $("remindersList");
  if (!reminders.length) { list.className = "empty"; list.textContent = "No reminders saved."; return; }
  list.className = "";
  list.innerHTML = reminders.map(r => `<div class="item"><div><strong>${safeText(r.reminder_time)} · ${safeText(r.medicine_name)}</strong><small>${safeText(r.instructions || "Follow your prescription")}</small></div><button class="secondary" data-delete="${r.id}" aria-label="Delete reminder">Delete</button></div>`).join("");
  list.querySelectorAll("[data-delete]").forEach(btn => btn.addEventListener("click", async () => {
    try { await api(`/api/reminders/${btn.dataset.delete}`, { method: "DELETE" }); await loadReminders(); }
    catch (err) { alert(err.message); }
  }));
}
$("enableNotifications").addEventListener("click", async () => {
  if (!("Notification" in window)) return setMessage("notificationMessage", "This browser does not support notifications.", true);
  const permission = await Notification.requestPermission();
  setMessage("notificationMessage", permission === "granted" ? "Notifications enabled while this page remains open." : "Notification permission was not granted.", permission !== "granted");
});
function checkReminderTimes() {
  if (!token || !("Notification" in window) || Notification.permission !== "granted") return;
  const now = new Date(); const hhmm = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  reminders.filter(r => r.reminder_time === hhmm).forEach(r => {
    const key = `medfusion-notified-${now.toDateString()}-${r.id}-${hhmm}`;
    if (!sessionStorage.getItem(key)) {
      new Notification("AI-MedFusion reminder", { body: `Reminder: ${r.medicine_name}. Follow your clinician's prescribed instructions.` });
      sessionStorage.setItem(key, "1");
    }
  });
}
setInterval(checkReminderTimes, 30000);
$("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const answer = $("chatAnswer"); answer.classList.remove("hidden"); answer.textContent = "Thinking…";
  try { const data = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: $("chatMessage").value }) }); answer.textContent = data.answer; }
  catch (err) { answer.textContent = err.message; }
});
$("imageForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const file = $("medicalImage").files[0]; const answer = $("imageAnswer");
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { answer.classList.remove("hidden"); answer.textContent = "Image must be 5 MB or smaller."; return; }
  answer.classList.remove("hidden"); answer.textContent = "Uploading image for a non-diagnostic description…";
  const form = new FormData(); form.append("image", file);
  try { const data = await api("/api/image-analysis", { method: "POST", body: form }); answer.textContent = `${data.result}\n\nIMPORTANT: ${data.disclaimer}`; }
  catch (err) { answer.textContent = err.message; }
});
if (token) enterApp(); else showApp(false);
