(() => {
  if (window.__meshWeeklyExporterInstalled) return;
  window.__meshWeeklyExporterInstalled = true;

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const reportProgress = (message) => chrome.runtime.sendMessage({ type: "MESH_COLLECTION_PROGRESS", message }).catch(() => {});

  function teacherName() {
    const text = norm(document.body.innerText);
    const match = text.match(/([А-ЯЁ][а-яё-]+\s+[А-ЯЁ][а-яё-]+(?:\s+[А-ЯЁ][а-яё-]+)?)\s+(?:ПРЕПОДАВАТЕЛЬ|УЧИТЕЛЬ)/i)
      || text.match(/([А-ЯЁ]\s+[А-ЯЁ]\s+[А-ЯЁ][а-яё-]+)\s+(?:ПРЕПОДАВАТЕЛЬ|УЧИТЕЛЬ)/i)
      || text.match(/([А-ЯЁ][а-яё-]+)\s+(?:ПРЕПОДАВАТЕЛЬ|УЧИТЕЛЬ)/i);
    return match?.[1] || "";
  }

  function parseDateLabel(label, weekStart) {
    const match = norm(label).match(/^(\d{1,2})\s+([а-яё]+)/i);
    if (!match) return "";
    const months = { янв: 0, фев: 1, мар: 2, апр: 3, мая: 4, май: 4, июн: 5, июл: 6, авг: 7, сен: 8, окт: 9, ноя: 10, дек: 11 };
    const key = match[2].slice(0, 3).toLowerCase();
    if (months[key] === undefined) return "";
    const year = Number((weekStart || "").slice(0, 4)) || new Date().getFullYear();
    let month = months[key];
    let actualYear = year;
    const startMonth = Number((weekStart || "").slice(5, 7)) - 1;
    if (Number.isFinite(startMonth) && startMonth >= 0 && month < startMonth - 5) actualYear += 1;
    if (Number.isFinite(startMonth) && startMonth >= 6 && month > startMonth + 5) actualYear -= 1;
    return `${actualYear}-${String(month + 1).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
  }

  function cardInfo(card, index, weekStart) {
    const cardLines = (card.innerText || "").split(/\n+/).map(norm).filter(Boolean);
    const subjectGroup = cardLines.find((line) => /(?:КСК|СПО|ОУП|ДУП)[.\s-]*\d/i.test(line)) || "";
    let dayContainer = card;
    while (dayContainer?.parentElement && !/^\d{1,2}\s+[а-яё]{3,}\s+(пн|вт|ср|чт|пт|сб|вс)/i.test(norm(dayContainer.innerText))) {
      dayContainer = dayContainer.parentElement;
    }
    const dayText = dayContainer === card ? "" : norm(dayContainer.innerText).split(/\n+/).slice(0, 2).join(" ");
    const dayLabel = dayText.match(/^(\d{1,2}\s+[а-яё]+)/i)?.[1] || "";
    const button = card.querySelector('[data-test-component="buttonToLesson"]');
    const id = card.getAttribute("data-test-component")?.match(/-Card-(\d+)$/)?.[1] || `lesson-${index + 1}`;
    return {
      id,
      date: parseDateLabel(dayLabel, weekStart),
      dayLabel,
      time: cardLines.find((line) => /^\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}$/.test(line)) || "",
      subjectGroup,
      topic: cardLines.filter((line) => line !== subjectGroup && !/^\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}$/.test(line) && !/^каб\./i.test(line) && !/^К журналу\s*К занятию$/i.test(line) && line !== "К журналу" && line !== "К занятию").join(" "),
      hasTopic: null,
      hasHomework: null,
      homework: [],
      lessonMaterialCount: null,
      hasLessonMaterial: null,
      lessonMaterials: null,
      lessonLibraryMaterialCount: null,
      lessonTeacherMaterialCount: null,
      lessonMaterialSourceDetails: "",
      materialCheck: "не проверено",
    };
  }

  function planningTable() {
    const blocks = [...document.querySelectorAll("table,[role='table'],[role='grid']")].filter((block) => {
      const rect = block.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    return blocks.find((block) => {
      const headers = norm([...block.querySelectorAll("thead th,th,[role='columnheader']")]
        .map((cell) => cell.innerText).join(" "));
      return /дисциплина/i.test(headers) && /профессия|специальность/i.test(headers) && /статус/i.test(headers);
    }) || null;
  }

  function readPlanningPage(pageNumber) {
    const table = planningTable();
    if (!table) return [];
    const nativeRows = [...table.querySelectorAll("tbody tr")];
    const rows = nativeRows.length ? nativeRows : [...table.querySelectorAll("tr,[role='row']")];
    return rows.map((row) => {
      const cells = row.matches("[role='row']")
        ? [...row.querySelectorAll("[role='cell'],[role='gridcell'],[role='columnheader']")]
        : [...row.querySelectorAll("td,th")];
      const statusCell = cells[5];
      const path = statusCell?.querySelector("svg path")?.getAttribute("d") || "";
      const statusText = norm(statusCell?.innerText || "");
      const isReadyIcon = path.includes("20.997 10.974H21") && path.includes("6.297 7.196");
      const otherIcon = Boolean(path) && !isReadyIcon;
      const developed = isReadyIcon ? true : otherIcon ? null : statusText ? null : false;
      return {
        discipline: norm(cells[0]?.innerText),
        profession: norm(cells[1]?.innerText),
        qualification: norm(cells[2]?.innerText),
        course: norm(cells[3]?.innerText),
        group: norm(cells[4]?.innerText),
        statusText,
        status: developed === true ? "Разработано" : developed === false ? "Нет отметки о разработке" : (statusText || "Индикатор требует сверки"),
        developed,
        statusIcon: isReadyIcon ? "галочка" : otherIcon ? "другой значок" : "нет значка",
        page: pageNumber
      };
    }).filter((item) => item.discipline || item.group);
  }

  async function collectPlanning() {
    const findStep = () => {
      const icon = document.querySelector('[data-test-component="calAndThemPlanningCard"]');
      const visible = (element) => Boolean(element && element.getBoundingClientRect().width > 0);
      const controls = [...document.querySelectorAll("button,[role='button'],[role='tab'],a,[tabindex]")]
        .filter(visible);
      const iconControl = icon?.closest("button,[role='button'],[role='tab'],a,[tabindex]");
      const matchesStepLabel = (element) => {
        const text = norm(element.innerText || element.getAttribute("aria-label") || element.getAttribute("title"));
        return /календарно[\s\u2010-\u2015-]*тематическ\w*\s+планирован\w*|календарно\s*тематическ\w*\s*планирован\w*|(?:шаг|этап)\s*3\b/i.test(text);
      };
      const labelled = [...document.querySelectorAll("button,[role='button'],[role='tab'],a,[tabindex],[data-test-component],div,section,article,li")]
        .filter((element) => visible(element) && matchesStepLabel(element))
        .sort((a, b) => norm(a.innerText).length - norm(b.innerText).length);
      if (labelled.length) return labelled[0];
      if (visible(iconControl)) return iconControl;
      return visible(icon) ? icon : controls.find(matchesStepLabel);
    };
    const until = Date.now() + 30000;
    let step = findStep();
    while (!step && !planningTable() && Date.now() < until) {
      reportProgress("Жду загрузку тематического планирования…");
      await pause(300);
      step = findStep();
    }
    if (step && !planningTable()) {
      const clickTarget = step.closest("button,[role='button'],[role='tab'],a,[tabindex]") || step;
      clickTarget.scrollIntoView({ block: "center", inline: "nearest" });
      clickTarget.focus?.({ preventScroll: true });
      clickTarget.click();
      reportProgress("Открываю шаг 3 «Календарно-тематическое планирование»…");
    }
    let table = planningTable();
    const tableUntil = Date.now() + 30000;
    while (!table && Date.now() < tableUntil) {
      await pause(300);
      table = planningTable();
    }
    if (!table) {
      const pageText = norm(document.body.innerText).slice(0, 240);
      const visibleBlocks = [...document.querySelectorAll("table,[role='table'],[role='grid']")]
        .filter((block) => block.getBoundingClientRect().width > 0)
        .map((block) => `${block.tagName.toLowerCase()}[role=${block.getAttribute("role") || ""}] rows=${block.querySelectorAll("tr,[role='row']").length} text=${norm(block.innerText).slice(0, 100)}`)
        .slice(0, 5).join(" | ");
      const error = step
        ? `Шаг 3 найден, но таблица тематического планирования не распознана за 30 секунд. Блоки: ${visibleBlocks || "таблиц и сеток нет"}. Текст страницы: ${pageText || "пусто"}`
        : `Не дождались шага 3 на странице тематического планирования. Проверьте вход и доступ к разделу. Видимый текст страницы: ${pageText || "пусто"}`;
      return { kind: "planning", teacher: teacherName(), groups: [], error };
    }

    const completionLabel = norm(step?.innerText || "").match(/готово\s*\(\s*\d+\s*из\s*\d+\s*\)/i)?.[0] || "";
    const pageButtons = () => [...document.querySelectorAll('button[aria-label^="Перейти на страницу"]')]
      .filter((button) => button.getBoundingClientRect().width > 0);
    const pages = [...new Set(pageButtons().map((button) => Number(button.getAttribute("aria-label").match(/(\d+)$/)?.[1])).filter(Number.isFinite))].sort((a, b) => a - b);
    const initialPage = Number(pageButtons().find((button) => button.getAttribute("aria-current") === "page")?.getAttribute("aria-label").match(/(\d+)$/)?.[1]) || 1;
    const groups = [];
    for (const pageNo of (pages.length ? pages : [initialPage])) {
      const button = pageButtons().find((item) => Number(item.getAttribute("aria-label").match(/(\d+)$/)?.[1]) === pageNo);
      if (button && button.getAttribute("aria-current") !== "page") {
        button.click();
        await pause(300);
      }
      groups.push(...readPlanningPage(pageNo));
      reportProgress(`КТП: обработана страница ${pageNo}/${Math.max(...(pages.length ? pages : [1]))}…`);
    }
    const restore = pageButtons().find((button) => Number(button.getAttribute("aria-label").match(/(\d+)$/)?.[1]) === initialPage);
    if (restore && restore.getAttribute("aria-current") !== "page") restore.click();
    return { kind: "planning", url: location.href, teacher: teacherName(), completionLabel, groups, capturedAt: new Date().toISOString() };
  }

  async function waitForModal(timeoutMs = 12000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const modal = document.querySelector('[data-test-component="LIModal"]');
      if (modal) {
        const headings = [...modal.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((el) => norm(el.innerText));
        const text = norm(modal.innerText);
        const materialsReady = headings.includes("Материалы к занятию");
        const homeworkReady = /Домашнее задание/i.test(text);
        if (materialsReady && homeworkReady) return modal;
      }
      await pause(100);
    }
    return null;
  }

  async function waitForModalClosed(timeoutMs = 4000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (!document.querySelector('[data-test-component="LIModal"]')) return true;
      await pause(100);
    }
    return !document.querySelector('[data-test-component="LIModal"]');
  }

  function setScheduleItemInUrl(lessonId, baseUrl = location.href) {
    const target = new URL(baseUrl, location.href);
    target.searchParams.set("scheduleItemId", lessonId);
    history.replaceState(history.state, "", target.href);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }

  function restoreScheduleUrl(baseUrl) {
    const target = new URL(baseUrl, location.href);
    target.searchParams.delete("scheduleItemId");
    history.replaceState(history.state, "", target.href);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }

  function readModal(modal, lesson) {
    const text = norm(modal.innerText);
    const materialHeading = [...modal.querySelectorAll("h1,h2,h3,h4,h5,h6")].find((el) => norm(el.innerText) === "Материалы к занятию");
    if (materialHeading) {
      const section = materialHeading.parentElement;
      const sectionText = norm(section?.innerText);
      if (/не добавили ни одного материала/i.test(sectionText)) {
        lesson.lessonMaterialCount = 0;
        lesson.hasLessonMaterial = false;
        lesson.lessonMaterials = [];
        lesson.lessonLibraryMaterialCount = 0;
        lesson.lessonTeacherMaterialCount = 0;
        lesson.lessonMaterialDetails = "нет материалов";
      } else {
        const materialCards = [...(section?.querySelectorAll('[data-test-component^="materialCardMenuList-"]') || [])]
          .map((menuButton) => {
            let card = menuButton.parentElement;
            while (card && card !== section && !card.querySelector("h5")) card = card.parentElement;
            const title = norm(card?.querySelector("h5")?.innerText);
            const description = norm(card?.querySelector("h5")?.nextElementSibling?.innerText);
            const sourceLabels = [...(card?.querySelectorAll("img") || [])]
              .flatMap((image) => [image.alt, image.title, image.getAttribute("aria-label")])
              .filter(Boolean)
              .map(norm);
            const isLibraryMaterial = sourceLabels.some((label) => /библиотека\s+мэш/i.test(label));
            return {
              title,
              description,
              source: isLibraryMaterial ? "Библиотека МЭШ" : "Материал преподавателя",
            };
          });
        lesson.lessonMaterials = materialCards;
        lesson.lessonLibraryMaterialCount = materialCards.filter((item) => item.source === "Библиотека МЭШ").length;
        lesson.lessonTeacherMaterialCount = materialCards.filter((item) => item.source === "Материал преподавателя").length;
        lesson.lessonMaterialSourceDetails = materialCards
          .map((item) => `${item.source}: ${item.title}`)
          .filter(Boolean)
          .join("; ");
        const materialCount = sectionText.match(/(?:материал(?:а|ов)?\s*[:(]?\s*)(\d+)/i);
        lesson.lessonMaterialCount = materialCards.length || (materialCount ? Number(materialCount[1]) : null);
        lesson.hasLessonMaterial = lesson.lessonMaterialCount === null ? null : lesson.lessonMaterialCount > 0;
        lesson.lessonMaterialDetails = sectionText.replace(/^Материалы к занятию\s*/i, "");
        if (lesson.lessonMaterialCount === null && lesson.lessonMaterialDetails) lesson.hasLessonMaterial = true;
      }
    }

    const taskTitles = [...modal.querySelectorAll('[data-test-component^="LILessonHomeworkCardViewHomeTask-"]')];
    lesson.homework = taskTitles.map((titleEl, taskIndex) => {
      const root = titleEl.parentElement?.parentElement;
      const taskText = norm(root?.innerText || titleEl.innerText);
      const indicatorNodes = [...(root?.querySelectorAll(".juY1N5drcZsqYgeg > div") || [])];
      const indicators = indicatorNodes.map((el) => Number(norm(el.innerText))).filter(Number.isFinite);
      const dueDate = taskText.match(/Проверить к:\s*([\d.]+)/i)?.[1] || "";
      const assignedAt = taskText.match(/Когда задано:\s*([\d.]+(?:\s+в\s+\d{1,2}:\d{2})?)/i)?.[1] || "";
      const assignment = norm(titleEl.innerText);
      return {
        id: titleEl.getAttribute("data-test-component")?.replace("LILessonHomeworkCardViewHomeTask-", "") || `task-${taskIndex + 1}`,
        title: assignment,
        description: taskText.replace(assignment, "").trim(),
        assignedAt,
        dueDate,
        indicators,
        hasMaterial: indicators.length ? indicators.some((value) => value >= 1) : null
      };
    });
    lesson.hasHomework = lesson.homework.length > 0;
    lesson.homeworkMaterialCount = lesson.homework.reduce((sum, task) => sum + (task.hasMaterial ? 1 : 0), 0);
    lesson.hasHomeworkMaterial = lesson.homework.length
      ? (lesson.homework.some((task) => task.hasMaterial === true) ? true : lesson.homework.every((task) => task.hasMaterial === false) ? false : null)
      : false;
    lesson.materialCheck = materialHeading ? "проверено" : "блок материалов не найден";
    lesson.homeworkCheck = taskTitles.length ? "проверено" : (text.includes("Домашнее задание") ? "ДЗ отсутствует" : "блок ДЗ не найден");
  }

  async function collectSchedule(weekStart) {
    const scheduleDeadline = Date.now() + 30000;
    let header = document.querySelector('[data-test-component="scheduleHeaderPopperDateLeftOn"]');
    while ((!header || !norm(header.innerText)) && Date.now() < scheduleDeadline) {
      reportProgress("Жду загрузку расписания МЭШ…");
      await pause(300);
      header = document.querySelector('[data-test-component="scheduleHeaderPopperDateLeftOn"]');
    }
    if (!header || !norm(header.innerText)) {
      throw new Error("Не дождались заголовка расписания МЭШ. Проверьте доступ к расписанию преподавателя.");
    }
    const week = norm(header.innerText);
    document.querySelector('[data-test-component="LIModal-Close"]')?.click();
    await pause(100);
    const baseUrl = new URL(location.href);
    baseUrl.searchParams.delete("scheduleItemId");
    const scheduleUrl = baseUrl.href;
    const cardsDeadline = Date.now() + 30000;
    let cards = [...document.querySelectorAll('[data-test-component^="scheduleDay-"][data-test-component*="-Card-"]')];
    while (!cards.length && Date.now() < cardsDeadline) {
      reportProgress("Расписание загружено. Жду карточки занятий…");
      await pause(300);
      cards = [...document.querySelectorAll('[data-test-component^="scheduleDay-"][data-test-component*="-Card-"]')];
    }
    if (!cards.length) {
      throw new Error(`Расписание за неделю «${week}» загрузилось, но карточки занятий не найдены. Проверка материалов и тем остановлена; КТП не будет выдано за полный отчёт.`);
    }
    reportProgress(`Расписание найдено: ${cards.length} занятий. Проверяю темы, ДЗ и материалы…`);
    const lessons = cards.map((card, index) => cardInfo(card, index, weekStart));
    for (let lessonIndex = 0; lessonIndex < lessons.length; lessonIndex += 1) {
      const lesson = lessons[lessonIndex];
      lesson.hasTopic = Boolean(lesson.topic);
      const card = [...document.querySelectorAll('[data-test-component^="scheduleDay-"][data-test-component*="-Card-"]')]
        .find((item) => item.getAttribute("data-test-component")?.endsWith(`-Card-${lesson.id}`));
      const button = card?.querySelector('[data-test-component="buttonToLesson"]');
      if (!button) {
        lesson.materialCheck = "кнопка «К занятию» не найдена";
        reportProgress(`Расписание: проверено ${lessonIndex + 1}/${lessons.length} занятий…`);
        continue;
      }
      try {
        document.querySelector('[data-test-component="LIModal-Close"]')?.click();
        await waitForModalClosed();
        setScheduleItemInUrl(lesson.id, scheduleUrl);
        let modal = await waitForModal(12000);
        if (!modal) {
          const partial = document.querySelector('[data-test-component="LIModal"]');
          partial?.querySelector('[data-test-component="LIModal-Close"]')?.click();
          await waitForModalClosed();
          restoreScheduleUrl(scheduleUrl);
          // Fallback: reveal the hover card, then click its visible action.
          card.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", view: window }));
          card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, view: window }));
          await pause(120);
          const visibleButtons = [...document.querySelectorAll('[data-test-component="buttonToLesson"]')]
            .filter((item) => item.getBoundingClientRect().width > button.getBoundingClientRect().width + 5);
          (visibleButtons.at(-1) || button).click();
          modal = await waitForModal(12000);
        }
        if (!modal) {
          const partial = document.querySelector('[data-test-component="LIModal"]');
          lesson.materialCheck = partial ? "окно открылось, но материалы/ДЗ не загрузились за 12 секунд" : "окно «К занятию» не открылось";
          partial?.querySelector('[data-test-component="LIModal-Close"]')?.click();
          await waitForModalClosed();
          restoreScheduleUrl(scheduleUrl);
          reportProgress(`Расписание: проверено ${lessonIndex + 1}/${lessons.length} занятий…`);
          continue;
        }
        const headings = [...modal.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((el) => norm(el.innerText));
        if (!headings.includes("Материалы к занятию") || !/Домашнее задание/i.test(norm(modal.innerText))) {
          lesson.materialCheck = "окно открылось, но материалы/ДЗ не загрузились за 12 секунд";
          modal.querySelector('[data-test-component="LIModal-Close"]')?.click();
          await waitForModalClosed();
          restoreScheduleUrl(scheduleUrl);
          reportProgress(`Расписание: проверено ${lessonIndex + 1}/${lessons.length} занятий…`);
          continue;
        }
        readModal(modal, lesson);
        const close = modal.querySelector('[data-test-component="LIModal-Close"]');
        close?.click();
        await waitForModalClosed();
        restoreScheduleUrl(scheduleUrl);
        await pause(150);
      } catch {
        lesson.materialCheck = "ошибка чтения окна занятия";
        document.querySelector('[data-test-component="LIModal-Close"]')?.click();
        restoreScheduleUrl(scheduleUrl);
      }
      reportProgress(`Расписание: проверено ${lessonIndex + 1}/${lessons.length} занятий…`);
    }
    restoreScheduleUrl(scheduleUrl);
    return { kind: "schedule", url: scheduleUrl, teacher: teacherName(), weekLabel: week, lessons, capturedAt: new Date().toISOString() };
  }

  function collectHomework() {
    const rows = [...document.querySelectorAll("table tbody tr")];
    const items = rows.map((row) => {
      const cells = [...row.querySelectorAll("th,td")].map((cell) => norm(cell.innerText));
      return { text: cells.join(" | "), cells, hasMaterial: null };
    }).filter((row) => row.text);
    const activeDateInput = [...document.querySelectorAll('input[data-test-component="calendarInput"]')].find((input) => !input.disabled && input.value);
    return { kind: "homework", url: location.href, teacher: teacherName(), periodLabel: activeDateInput?.value || "", homework: items, capturedAt: new Date().toISOString() };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "MESH_COLLECT_PAGE") return;
    const path = location.pathname;
    if (path.endsWith("/account/schedule")) {
      collectSchedule(message.weekStart).then((data) => {
        sendResponse({ ok: true, data });
        chrome.runtime.sendMessage({ type: "MESH_COLLECTION_RESULT", data }).catch(() => {});
      }).catch((error) => {
        const text = String(error?.message || error);
        sendResponse({ ok: false, error: text });
        chrome.runtime.sendMessage({ type: "MESH_COLLECTION_ERROR", error: text }).catch(() => {});
      });
    } else if (path.endsWith("/study-process/home-tasks")) sendResponse({ ok: true, data: collectHomework() });
    else if (path.endsWith("/study-process/planning")) {
      collectPlanning().then((data) => {
        if (data.error) {
          sendResponse({ ok: false, error: data.error });
          chrome.runtime.sendMessage({ type: "MESH_COLLECTION_ERROR", error: data.error, preserveTab: true }).catch(() => {});
        } else {
          sendResponse({ ok: true, data });
          chrome.runtime.sendMessage({ type: "MESH_COLLECTION_RESULT", data }).catch(() => {});
        }
      }).catch((error) => {
        const text = String(error?.message || error);
        sendResponse({ ok: false, error: text });
        chrome.runtime.sendMessage({ type: "MESH_COLLECTION_ERROR", error: text }).catch(() => {});
      });
    }
    else sendResponse({ ok: false, error: "Откройте «Моё расписание» или «Домашние задания» в кабинете преподавателя СПО." });
    return true;
  });
})();
