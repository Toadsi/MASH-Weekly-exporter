importScripts("report-core.js");

const REPORT_KEY = "meshWeeklyReportV1";
const RUN_KEY = "meshWeeklyRunState";
const FLOW_KEY = "meshWeeklyFlow";
const EMAIL_KEY = "meshWeeklyAdminEmail";
const SCHEDULE_URL = "https://school.mos.ru/spo/teacher/account/schedule";
const PLANNING_URL = "https://school.mos.ru/spo/teacher/study-process/planning";
const MAIL_URL = "https://mail.yandex.ru/";

async function updateRun(state) {
  await chrome.storage.local.set({ [RUN_KEY]: { ...state, updatedAt: Date.now() } });
}

async function getFlow() {
  const values = await chrome.storage.local.get(FLOW_KEY);
  return values[FLOW_KEY] || null;
}

async function startCollection(weekStart) {
  const current = await getFlow();
  if (current) {
    await updateRun({ running: true, message: "Сбор уже выполняется. Расширение само перейдёт от расписания к КТП." });
    return;
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active?.url?.startsWith("https://school.mos.ru/spo/teacher/")) {
    await updateRun({ running: false, error: true, message: "Сначала откройте любую страницу преподавателя в МЭШ и повторите сбор." });
    return;
  }
  await updateRun({ running: true, message: "Открываю фоновую вкладку МЭШ для сбора расписания…" });
  const scheduleUrl = active.url.includes("/account/schedule") ? active.url : SCHEDULE_URL;
  const tab = await chrome.tabs.create({ url: scheduleUrl, active: false });
  await chrome.storage.local.set({
    [FLOW_KEY]: {
      tabId: tab.id,
      weekStart,
      stage: "loading-schedule",
      startedAt: Date.now(),
      report: { weekStart, weekEnd: addDays(weekStart, 6), teacher: "", pages: {} }
    }
  });
  if (tab.status === "complete") await beginPageCollection(tab.id, "schedule");
}

function addDays(iso, n) {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + n);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function beginPageCollection(tabId, kind) {
  const flow = await getFlow();
  if (!flow || flow.tabId !== tabId) return;
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith("https://school.mos.ru/spo/teacher/")) {
    flow.stage = "waiting-auth";
    await chrome.storage.local.set({ [FLOW_KEY]: flow });
    await updateRun({ running: true, message: "Сессия МЭШ истекла. Войдите в открывшейся вкладке; после входа сбор продолжится автоматически." });
    await chrome.tabs.update(tabId, { active: true });
    return;
  }
  const targetUrl = kind === "schedule" ? SCHEDULE_URL : PLANNING_URL;
  if (new URL(tab.url).pathname !== new URL(targetUrl).pathname) {
    await chrome.tabs.update(tabId, { url: targetUrl });
    return;
  }
  const expectedStage = kind === "schedule" ? "loading-schedule" : "loading-planning";
  if (flow.stage !== expectedStage) return;
  flow.stage = kind === "schedule" ? "collecting-schedule" : "collecting-planning";
  await chrome.storage.local.set({ [FLOW_KEY]: flow });
  await updateRun({ running: true, message: kind === "schedule" ? "Проверяю уроки, материалы и ДЗ… Не закрывайте МЭШ, сбор идёт в фоне." : "Проверяю статусы разработки КТП на шаге 3…" });
  try {
    let response;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        response = await chrome.tabs.sendMessage(tabId, { type: "MESH_COLLECT_PAGE", weekStart: flow.weekStart });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await delay(700);
      }
    }
    if (!response?.ok) await finishWithError(response?.error || "Страница МЭШ не вернула данные.");
  } catch (error) {
    // The content script also reports the result directly. A lost response channel
    // must not discard a collection that is still running in the page.
    if (!String(error?.message || error).includes("message port closed")) {
      await finishWithError("Не удалось связаться со страницей МЭШ. Обновите страницу и повторите сбор.");
    }
  }
}

async function handleResult(data, senderTabId) {
  const flow = await getFlow();
  if (!flow || !data || !["schedule", "planning"].includes(data.kind)) return;
  if (senderTabId !== undefined && senderTabId !== flow.tabId) return;
  if (data.kind === "schedule" && flow.stage !== "collecting-schedule") return;
  if (data.kind === "planning" && flow.stage !== "collecting-planning") return;
  if (data.teacher) flow.report.teacher = data.teacher;
  flow.report.pages[data.kind] = data;
  await chrome.storage.local.set({ [FLOW_KEY]: flow });
  if (data.kind === "schedule") {
    // Persist the schedule as soon as it is collected. If KTP or email later fails,
    // the lesson, homework, topic, and material checks remain available for CSV export.
    const partialValues = await chrome.storage.local.get(REPORT_KEY);
    const partialStore = partialValues[REPORT_KEY] || {};
    partialStore[`${flow.weekStart}:${flow.report.teacher}`] = flow.report;
    await chrome.storage.local.set({ [REPORT_KEY]: partialStore });
    flow.stage = "loading-planning";
    await chrome.storage.local.set({ [FLOW_KEY]: flow });
    await updateRun({ running: true, message: "Расписание собрано. Перехожу к тематическому планированию, шаг 3…" });
    await chrome.tabs.update(flow.tabId, { url: PLANNING_URL });
    return;
  }
  const storeValues = await chrome.storage.local.get(REPORT_KEY);
  const store = storeValues[REPORT_KEY] || {};
  const key = `${flow.weekStart}:${flow.report.teacher}`;
  store[key] = flow.report;
  await chrome.storage.local.set({ [REPORT_KEY]: store });
  const lessons = flow.report.pages.schedule?.lessons || [];
  const checked = lessons.filter((lesson) => lesson.materialCheck === "проверено").length;
  const groups = data.groups || [];
  const emailValues = await chrome.storage.local.get(EMAIL_KEY);
  const recipient = String(emailValues[EMAIL_KEY] || "").trim();
  if (!recipient) {
    await chrome.storage.local.remove(FLOW_KEY);
    try { await chrome.tabs.remove(flow.tabId); } catch {}
    await updateRun({
      running: false,
      complete: true,
      weekStart: flow.weekStart,
      teacher: flow.report.teacher,
      message: `Сбор завершён: занятия ${checked}/${lessons.length}; КТП — ${groups.length} строк. Укажите email администрации — отправка не выполнена.`
    });
    return;
  }

  const csv = MeshReportCsv.buildCsv([flow.report]);
  const oldMeshTabId = flow.tabId;
  const mailTab = await chrome.tabs.create({ url: MAIL_URL, active: false });
  flow.stage = "loading-mail";
  flow.tabId = mailTab.id;
  flow.recipient = recipient;
  flow.filename = `mesh-weekly-${flow.weekStart}.csv`;
  flow.csv = csv;
  await chrome.storage.local.set({ [FLOW_KEY]: flow });
  try { await chrome.tabs.remove(oldMeshTabId); } catch {}
  await updateRun({ running: true, message: `Отчёт готов. Открываю Яндекс Почту для отправки на ${recipient}…` });
  if (mailTab.status === "complete") await beginMailSend(mailTab.id);
}

async function beginMailSend(tabId) {
  const flow = await getFlow();
  if (!flow || flow.tabId !== tabId || !["loading-mail", "waiting-mail-auth"].includes(flow.stage)) return;
  flow.stage = "checking-mail-session";
  await chrome.storage.local.set({ [FLOW_KEY]: flow });
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url?.startsWith("https://mail.yandex.ru/")) {
    flow.stage = "waiting-mail-auth";
    await chrome.storage.local.set({ [FLOW_KEY]: flow });
    await updateRun({ running: true, message: "Войдите в Яндекс Почту в открывшейся вкладке. После входа отчёт отправится автоматически." });
    await chrome.tabs.update(tabId, { active: true });
    return;
  }
  flow.stage = "sending-mail";
  await chrome.storage.local.set({ [FLOW_KEY]: flow });
  await updateRun({ running: true, message: `Отправляю CSV на ${flow.recipient} через Яндекс Почту…` });
  try {
    let response;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        response = await chrome.tabs.sendMessage(tabId, {
          type: "MESH_MAIL_SEND",
          recipient: flow.recipient,
          subject: `Отчёт МЭШ за неделю с ${flow.weekStart}`,
          filename: flow.filename,
          csv: flow.csv,
          teacher: flow.report.teacher,
          weekStart: flow.weekStart
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await delay(800);
      }
    }
    if (!response?.ok) await finishMail(tabId, false, response?.error || "Яндекс Почта не подтвердила отправку.");
  } catch (error) {
    await finishMail(tabId, false, `Не удалось открыть форму письма Яндекс Почты: ${String(error?.message || error)}`);
  }
}

async function finishMail(tabId, ok, message) {
  const flow = await getFlow();
  if (flow?.tabId === tabId) {
    await chrome.storage.local.remove(FLOW_KEY);
    if (ok) {
      try { await chrome.tabs.remove(tabId); } catch {}
    } else {
      try { await chrome.tabs.update(tabId, { active: true }); } catch {}
    }
  }
  await updateRun({
    running: false,
    complete: ok,
    error: !ok,
    weekStart: flow?.weekStart,
    recipient: flow?.recipient,
    message: ok ? `Отчёт CSV отправлен на ${flow?.recipient}. ${message || ""}` : `Отчёт собран, но письмо не отправлено: ${message}`
  });
}

async function finishWithError(message, preserveTab = false) {
  const flow = await getFlow();
  await chrome.storage.local.remove(FLOW_KEY);
  if (flow?.tabId) {
    if (preserveTab) {
      try { await chrome.tabs.update(flow.tabId, { active: true }); } catch {}
    } else {
      try { await chrome.tabs.remove(flow.tabId); } catch {}
    }
  }
  const lessons = flow?.report?.pages?.schedule?.lessons || [];
  const checked = lessons.filter((lesson) => lesson.materialCheck === "проверено").length;
  const topics = lessons.filter((lesson) => lesson.hasTopic === true).length;
  const savedSchedule = lessons.length
    ? ` Расписание сохранено: материалы/ДЗ проверены ${checked}/${lessons.length}; тема указана ${topics}/${lessons.length}. Его можно выгрузить в CSV.`
    : "";
  await updateRun({ running: false, error: true, message: `${message}${savedSchedule}` });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "MESH_START_AUTOMATION") {
    startCollection(message.weekStart).catch((error) => finishWithError(String(error?.message || error)));
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "MESH_CANCEL_AUTOMATION") {
    finishWithError("Сбор остановлен пользователем.").catch(() => {});
    return false;
  }
  if (message?.type === "MESH_COLLECTION_PROGRESS") {
    updateRun({ running: true, message: message.message }).catch(() => {});
    return false;
  }
  if (message?.type === "MESH_COLLECTION_RESULT") {
    handleResult(message.data, sender?.tab?.id).catch((error) => finishWithError(String(error?.message || error)));
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "MESH_COLLECTION_ERROR") {
    finishWithError(message.error || "Ошибка при сборе страницы МЭШ.", Boolean(message.preserveTab)).catch(() => {});
    return false;
  }
  if (message?.type === "MESH_MAIL_RESULT") {
    finishMail(sender?.tab?.id, Boolean(message.ok), message.message || "").catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getFlow().then((flow) => {
    if (flow?.tabId === tabId && ["loading-schedule", "collecting-schedule", "loading-planning", "collecting-planning", "waiting-auth"].includes(flow.stage)) {
      return finishWithError("Фоновая вкладка МЭШ была закрыта до завершения сбора.");
    }
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  getFlow().then((flow) => {
    if (!flow || flow.tabId !== tabId) return;
    if (flow.stage === "waiting-auth") {
      return chrome.tabs.get(tabId).then((tab) => {
        if (tab.url?.startsWith("https://school.mos.ru/spo/teacher/")) {
          flow.stage = "loading-schedule";
          return chrome.storage.local.set({ [FLOW_KEY]: flow }).then(() => beginPageCollection(tabId, "schedule"));
        }
      });
    }
    if (flow.stage === "loading-schedule") return beginPageCollection(tabId, "schedule");
    if (flow.stage === "loading-planning") return beginPageCollection(tabId, "planning");
    if (flow.stage === "loading-mail" || flow.stage === "waiting-mail-auth") return beginMailSend(tabId);
  }).catch(() => {});
});
