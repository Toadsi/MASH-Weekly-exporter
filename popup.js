const STORE_KEY = "meshWeeklyReportV1";
const EMAIL_KEY = "meshWeeklyAdminEmail";
const $ = (id) => document.getElementById(id);

function fmtDate(date) {
  if (!date) return "";
  const d = new Date(`${date}T00:00:00`);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
}
function mondayOfPreviousWeek() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - (day === 0 ? 7 : day));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function esc(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function pct(n, d) { return d ? `${(100 * n / d).toFixed(1).replace(".", ",")}%` : ""; }
async function loadStore() {
  const result = await chrome.storage.local.get(STORE_KEY);
  return result[STORE_KEY] || {};
}
function setStatus(message) { $("status").textContent = message; }
function renderRunState(state) {
  if (!state) return;
  setStatus(state.message || "");
  $("collect").disabled = Boolean(state.running);
}
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function startAutomation() {
  const weekStart = $("weekStart").value;
  if (!weekStart) { setStatus("Укажите дату начала недели."); return; }
  const adminEmail = $("adminEmail").value.trim();
  if (adminEmail && !$("adminEmail").checkValidity()) { setStatus("Проверьте формат email администрации."); return; }
  await chrome.storage.local.set({ [EMAIL_KEY]: adminEmail });
  setStatus("Запускаю автоматический сбор расписания и КТП…");
  $("collect").disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "MESH_START_AUTOMATION", weekStart });
    if (!result?.ok) throw new Error("Расширение не запустило сбор.");
  } catch {
    $("collect").disabled = false;
    setStatus("Не удалось запустить сбор. Перезагрузите расширение и страницу МЭШ.");
  }
}

async function saveAdminEmail() {
  const input = $("adminEmail");
  const email = input.value.trim();
  if (email && !input.checkValidity()) {
    setStatus("Проверьте формат email администрации.");
    return;
  }
  await chrome.storage.local.set({ [EMAIL_KEY]: email });
  setStatus(email ? `Адрес администрации сохранён: ${email}` : "Адрес администрации очищен.");
}

async function exportCsv() {
  const weekStart = $("weekStart").value;
  const store = await loadStore();
  const reports = Object.values(store).filter((item) => item.weekStart === weekStart && (item.pages?.schedule || item.pages?.planning));
  if (!reports.length) {
    setStatus("Нет собранных данных за выбранную неделю.");
    return;
  }
  const csv = MeshReportCsv.buildCsv(reports);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mesh-weekly-${weekStart}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus(`CSV скачан. Собрано отчётов: ${reports.length}.`);
}
async function clearStore() {
  try { await chrome.runtime.sendMessage({ type: "MESH_CANCEL_AUTOMATION" }); } catch {}
  await chrome.storage.local.remove(STORE_KEY);
  await chrome.storage.local.remove(["meshWeeklyFlow", "meshWeeklyRunState"]);
  $("collect").disabled = false;
  setStatus("Локальные данные очищены.");
}

document.addEventListener("DOMContentLoaded", () => {
  $("weekStart").value = mondayOfPreviousWeek();
  $("collect").addEventListener("click", startAutomation);
  $("export").addEventListener("click", exportCsv);
  $("clear").addEventListener("click", clearStore);
  $("adminEmail").addEventListener("change", saveAdminEmail);
  chrome.storage.local.get(EMAIL_KEY).then((result) => { $("adminEmail").value = result[EMAIL_KEY] || ""; });
  chrome.storage.local.get("meshWeeklyRunState").then((result) => renderRunState(result.meshWeeklyRunState));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.meshWeeklyRunState) renderRunState(changes.meshWeeklyRunState.newValue);
  });
});
