(() => {
const fmtDate = (date) => {
  if (!date) return "";
  const d = new Date(`${date}T00:00:00`);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
};
const pct = (n, d) => d ? `${(100 * n / d).toFixed(1).replace(".", ",")}%` : "";
const esc = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
function toRows(report, totals) {
  const schedule = report.pages.schedule;
  const lessons = schedule?.lessons || [];
  const tasks = lessons.flatMap((lesson) => lesson.homework || []);
  const groups = report.pages.planning?.groups || [];
  const lessonMaterialsKnown = lessons.every((lesson) => typeof lesson.hasLessonMaterial === "boolean");
  const topicKnown = lessons.every((lesson) => typeof lesson.hasTopic === "boolean");
  const taskMaterialsKnown = tasks.every((task) => typeof task.hasMaterial === "boolean");
  const groupStatusKnown = groups.every((group) => typeof group.developed === "boolean");
  const lessonsWithMaterial = lessons.filter((lesson) => lesson.hasLessonMaterial === true).length;
  const lessonMaterialSourcesKnown = lessons.every((lesson) =>
    Number.isInteger(lesson.lessonLibraryMaterialCount) && Number.isInteger(lesson.lessonTeacherMaterialCount)
  );
  const libraryMaterials = lessons.reduce((sum, lesson) => sum + (lesson.lessonLibraryMaterialCount || 0), 0);
  const teacherMaterials = lessons.reduce((sum, lesson) => sum + (lesson.lessonTeacherMaterialCount || 0), 0);
  const lessonsWithTopic = lessons.filter((lesson) => lesson.hasTopic === true).length;
  const tasksWithMaterial = tasks.filter((task) => task.hasMaterial === true).length;
  const developed = groups.filter((group) => group.developed === true).length;
  const notDeveloped = groups.filter((group) => group.developed === false).length;
  const allChecks = lessons.every((lesson) => lesson.materialCheck === "проверено" && ["проверено", "ДЗ отсутствует"].includes(lesson.homeworkCheck));
  const header = [
    "Тип строки", "Преподаватель", "Начало недели", "Конец недели", "День", "Дата", "Время", "Дисциплина и группа", "Тема занятия", "Тема указана",
    "ДЗ в занятии, шт.", "Название ДЗ", "Текст/сведения о ДЗ", "Выдано", "Проверить к", "Показатели у ДЗ", "ДЗ с материалом",
    "Материалов к занятию, шт.", "К занятию есть материалы", "Материалы к занятию (описание)", "Проверка карточки",
    "Дисциплина КТП", "Группа по дисциплине", "Профессия/специальность", "Квалификация", "Курс", "Статус разработки КТП", "Индикатор статуса", "Сводный статус шага 3",
    "Итого уроков", "Уроков с материалами", "Доля уроков с материалами, %", "Уроков с темой", "Без темы", "Доля уроков с темой, %",
    "ДЗ всего", "ДЗ с материалами", "Доля ДЗ с материалами, %", "Групп в шаге 3", "КТП разработано", "КТП без отметки",
    "Педагогов с расписанием (собранные отчёты)", "Педагогов с материалами (собранные отчёты)", "Доля педагогов с материалами, % (собранные отчёты)", "Статус выгрузки",
    "Материалов из библиотеки МЭШ, шт.", "Материалов преподавателя, шт.", "Источники материалов к занятию"
  ];
  const blankRow = () => Array(header.length).fill("");
  const summary = blankRow();
  Object.assign(summary, {
    0: "ИТОГО", 1: report.teacher, 2: fmtDate(report.weekStart), 3: fmtDate(report.weekEnd),
    20: schedule ? (allChecks ? "карточки расписания проверены" : "есть непроверенные карточки") : "расписание не собрано",
    28: schedule ? lessons.length : "", 29: schedule ? lessonsWithMaterial : "",
    30: schedule && lessonMaterialsKnown ? pct(lessonsWithMaterial, lessons.length) : "",
    31: schedule ? lessonsWithTopic : "", 32: schedule ? lessons.filter((lesson) => lesson.hasTopic === false).length : "",
    33: schedule && topicKnown ? pct(lessonsWithTopic, lessons.length) : "",
    34: schedule ? tasks.length : "", 35: schedule ? tasksWithMaterial : "",
    36: schedule && taskMaterialsKnown ? pct(tasksWithMaterial, tasks.length) : "",
    37: report.pages.planning ? groups.length : "", 38: report.pages.planning ? developed : "", 39: report.pages.planning ? notDeveloped : "",
    41: totals.scheduled, 42: totals.withMaterial, 43: pct(totals.withMaterial, totals.scheduled),
    44: [report.pages.schedule ? `расписание: ${lessons.length} занятий` : "", report.pages.planning ? `шаг 3: ${groups.length} групп (${report.pages.planning.completionLabel || "статус см. в строках ниже"})` : ""].filter(Boolean).join("; "),
    45: schedule && lessonMaterialSourcesKnown ? libraryMaterials : "",
    46: schedule && lessonMaterialSourcesKnown ? teacherMaterials : ""
  });
  const detailRows = [];
  for (const lesson of lessons) {
    const lessonTasks = lesson.homework?.length ? lesson.homework : [null];
    for (const task of lessonTasks) {
      const row = blankRow();
      Object.assign(row, {
        0: "ЗАНЯТИЕ / ДЗ", 1: report.teacher, 2: fmtDate(report.weekStart), 3: fmtDate(report.weekEnd), 4: lesson.dayLabel,
        5: fmtDate(lesson.date), 6: lesson.time, 7: lesson.subjectGroup, 8: lesson.topic,
        9: lesson.hasTopic === true ? "Да" : lesson.hasTopic === false ? "Нет" : "Не проверено",
        10: lesson.homework?.length ?? "", 11: task?.title || (lesson.hasHomework === false ? "Домашнего задания нет" : ""),
        12: task?.description || "", 13: task?.assignedAt || "", 14: task?.dueDate || "", 15: task?.indicators?.join(", ") || "",
        16: task ? (task.hasMaterial === true ? "Да" : task.hasMaterial === false ? "Нет" : "Не проверено") : (lesson.hasHomework === false ? "Нет ДЗ" : ""),
        17: lesson.lessonMaterialCount ?? "", 18: lesson.hasLessonMaterial === true ? "Да" : lesson.hasLessonMaterial === false ? "Нет" : "Не проверено",
        19: lesson.lessonMaterialDetails || "", 20: [lesson.materialCheck, lesson.homeworkCheck].filter(Boolean).join("; "),
        45: Number.isInteger(lesson.lessonLibraryMaterialCount) ? lesson.lessonLibraryMaterialCount : "",
        46: Number.isInteger(lesson.lessonTeacherMaterialCount) ? lesson.lessonTeacherMaterialCount : "",
        47: lesson.lessonMaterialSourceDetails || ""
      });
      detailRows.push(row);
    }
  }
  for (const group of groups) {
    const row = blankRow();
    Object.assign(row, {
      0: "КТП / ШАГ 3", 1: report.teacher, 2: fmtDate(report.weekStart), 3: fmtDate(report.weekEnd),
      21: group.discipline, 22: group.group, 23: group.profession, 24: group.qualification, 25: group.course,
      26: group.status, 27: group.statusIcon, 28: report.pages.planning?.completionLabel || ""
    });
    detailRows.push(row);
  }
  return [header, summary, ...detailRows];
}

function buildCsv(reports) {
  const scheduled = reports.filter((item) => item.pages.schedule && (item.pages.schedule.lessons || []).length > 0);
  const totals = {
    scheduled: scheduled.length,
    withMaterial: scheduled.filter((item) => (item.pages.schedule.lessons || []).some((lesson) => lesson.hasLessonMaterial === true)).length
  };
  const rows = [];
  for (const report of reports) {
    const reportRows = toRows(report, totals);
    rows.push(...(rows.length ? reportRows.slice(1) : reportRows));
  }
  return "\uFEFF" + rows.map((row) => row.map(esc).join(";")).join("\r\n");
}
globalThis.MeshReportCsv = { buildCsv };
})();
