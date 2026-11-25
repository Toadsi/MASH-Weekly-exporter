(() => {
  if (window.__meshMailSenderInstalled) return;
  window.__meshMailSenderInstalled = true;

  const normalize = (value) => (value || "").replace(/\s+/g, " ").trim();
  const visible = (element) => Boolean(element && element.getClientRects().length);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(getValue, timeout = 15000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = getValue();
      if (value) return value;
      await pause(200);
    }
    return null;
  }

  function findVisibleTextElement(text, selectors = "button,[role='button'],a") {
    return [...document.querySelectorAll(selectors)].find((element) =>
      visible(element) && normalize(element.innerText || element.getAttribute("aria-label")) === text);
  }

  function findComposeButton() {
    const byQa = [...document.querySelectorAll('[data-qa="compose-button"],[data-testid="compose-button"]')]
      .find(visible);
    if (byQa) return byQa;
    return [...document.querySelectorAll("button,[role='button'],a")].find((element) => {
      if (!visible(element)) return false;
      const label = normalize(element.innerText) || normalize(element.getAttribute("aria-label")) || normalize(element.title);
      return /^(написать(?:\s+письмо)?|создать\s+письмо)$/i.test(label);
    });
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function recipientFieldHint(element) {
    const parts = [element.placeholder, element.getAttribute("aria-label"), element.getAttribute("name"),
      element.getAttribute("data-qa"), element.getAttribute("data-testid"), element.title];
    let parent = element;
    for (let depth = 0; depth < 4 && parent; depth += 1, parent = parent.parentElement) {
      parts.push(parent.getAttribute?.("data-qa"), parent.getAttribute?.("data-testid"), parent.getAttribute?.("aria-label"));
    }
    return parts.filter(Boolean).join(" ").toLowerCase();
  }

  function findRecipientField() {
    const editable = "input:not([type='hidden']):not([type='file']),textarea,[role='combobox'],[contenteditable='true'],div[contenteditable='true']";
    const candidates = [...document.querySelectorAll(editable)].filter((element) => visible(element));

    const explicit = candidates.find((element) => {
      const hint = recipientFieldHint(element);
      return /кому|получател|recipient|compose.?to|to.?field|mailbox.*to/.test(hint)
        || /^(\s*кому\s*|\s*to\s*|\s*recipient\s*)$/i.test(normalize(element.getAttribute("placeholder") || element.getAttribute("aria-label") || ""));
    });
    if (explicit) return explicit;

    const fieldByText = candidates.find((element) => {
      const text = normalize(element.value || element.textContent || "");
      return /кому|to|recipient/.test(text.toLowerCase());
    });
    if (fieldByText) return fieldByText;

    const labels = [...document.querySelectorAll("label,span,div")].filter((element) =>
      visible(element) && element.children.length <= 4 && /^(кому|to|recipient)$/i.test(normalize(element.innerText)));
    for (const label of labels) {
      let parent = label;
      for (let depth = 0; depth < 5 && parent; depth += 1, parent = parent.parentElement) {
        const nested = [...(parent.querySelectorAll?.(editable) || [])].find(visible);
        if (nested) return nested;
      }
    }
    return null;
  }

  function setTextContent(target, value) {
    if (!target) return;
    target.focus();
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      setInputValue(target, value);
      return;
    }
    target.textContent = value;
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }

  function setRecipient(field, value) {
    const target = field?.querySelector?.("input,textarea,[contenteditable='true'],[role='textbox'],[role='combobox']") || field;
    if (!target) return;
    setTextContent(target, value);
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  }

  async function sendReport({ recipient, subject, filename, csv, teacher, weekStart }) {
    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new Error("В расширении не указан корректный email администрации.");
    const composeButton = await waitFor(findComposeButton, 30000);
    if (!composeButton) throw new Error("Не нашла кнопку создания письма. Проверьте, что открыта авторизованная Яндекс Почта, и повторите сбор.");
    composeButton.click();

    const recipientInput = await waitFor(findRecipientField, 20000);
    if (!recipientInput) throw new Error("Не нашла поле получателя в окне письма. Окно оставлено открытым.");
    setRecipient(recipientInput, recipient);
    const recipientFieldText = normalize(recipientInput.value || recipientInput.textContent || "");
    const recipientChip = await waitFor(() => [...document.querySelectorAll("*")].find((element) =>
      visible(element) && element.children.length < 3 && normalize(element.innerText) === recipient), 8000);
    if (!recipientChip && !recipientFieldText.includes(recipient)) throw new Error("Яндекс Почта не приняла адрес получателя.");

    const subjectInput = await waitFor(() => [...document.querySelectorAll("input")].find((input) => {
      const hint = `${input.placeholder || ""} ${input.getAttribute("aria-label") || ""} ${input.name || ""}`.toLowerCase();
      return visible(input) && (/тема|subject/.test(hint));
    }));
    if (!subjectInput) throw new Error("Не нашла поле темы письма.");
    setInputValue(subjectInput, subject);

    const bodyField = await waitFor(() => {
      const editable = [...document.querySelectorAll("textarea,[contenteditable='true'],[role='textbox']")]
        .filter((element) => visible(element) && element !== recipientInput);
      return editable.find((element) => {
        const hint = normalize(`${element.getAttribute("aria-label") || ""} ${element.getAttribute("placeholder") || ""} ${element.getAttribute("name") || ""} ${element.value || element.textContent || ""}`);
        return !/кому|to|recipient/i.test(hint);
      }) || editable[0];
    });
    if (!bodyField) throw new Error("Не нашла поле текста письма.");
    const bodyText = `Добрый день!\n\nНаправляю отчёт МЭШ за неделю с ${weekStart}.\nПреподаватель: ${teacher || "не определён"}.\nФайл CSV приложен автоматически.`;
    setTextContent(bodyField, bodyText);

    const composeRoot = bodyField.closest("[role='dialog']") || subjectInput.closest("form") || document;
    let fileInput = [...composeRoot.querySelectorAll("input[type='file']")].find((input) => !input.disabled)
      || [...document.querySelectorAll("input[type='file']")].find((input) => !input.disabled);
    if (!fileInput) throw new Error("В окне письма не найдено поле прикрепления файла; письмо не отправлено.");
    const file = new File([csv], filename, { type: "text/csv;charset=utf-8" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event("input", { bubbles: true }));
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    const attached = await waitFor(() => [...document.querySelectorAll("*")].find((element) =>
      visible(element) && element.children.length < 4 && normalize(element.innerText).includes(filename)), 30000);
    if (!attached) throw new Error("Файл CSV не появился среди вложений; письмо не отправлено.");
    await pause(1000);

    const pageText = normalize(document.body.innerText);
    if (!pageText.includes(recipient)) throw new Error("Перед отправкой не удалось подтвердить адрес получателя.");
    const sendButton = findVisibleTextElement("Отправить");
    if (!sendButton) throw new Error("Не нашла кнопку «Отправить»; письмо оставлено в черновиках.");
    sendButton.click();

    const sent = await waitFor(() => {
      const text = normalize(document.body.innerText);
      if (/письмо отправлено|сообщение отправлено|письмо отправлено успешно/i.test(text)) return true;
      const composeStillOpen = [...document.querySelectorAll("input")].some((input) => visible(input) && input.value === subject);
      return !composeStillOpen ? true : null;
    }, 30000);
    if (!sent) throw new Error("Яндекс Почта не подтвердила отправку письма.");
    return `Письмо отправлено на ${recipient} с вложением ${filename}.`;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "MESH_MAIL_SEND") return false;
    sendReport(message).then((text) => {
      sendResponse({ ok: true, message: text });
      chrome.runtime.sendMessage({ type: "MESH_MAIL_RESULT", ok: true, message: text }).catch(() => {});
    }).catch((error) => {
      const text = String(error?.message || error);
      sendResponse({ ok: false, error: text });
      chrome.runtime.sendMessage({ type: "MESH_MAIL_RESULT", ok: false, message: text }).catch(() => {});
    });
    return true;
  });
})();
