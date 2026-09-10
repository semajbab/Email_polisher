// Captures the highlighted text, hands it to the service worker, and puts the
// rewrite back where the original was. Runs in every frame; only the focused
// frame acts on the hotkey.

(() => {
  if (window.__emailPolisherLoaded) return;
  window.__emailPolisherLoaded = true;

  const FIELD_INPUT_TYPES = new Set(["text", "search", "url", "email", "tel", ""]);

  let busy = false;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "REFINE_SELECTION") return false;
    // Every frame gets the message; only the focused one owns the selection.
    // Answer anyway so the worker's sendMessage promise resolves instead of
    // rejecting on a closed port and re-firing the whole thing.
    sendResponse({ handled: document.hasFocus() });
    if (document.hasFocus()) refineSelection();
    return false;
  });

  async function refineSelection() {
    if (busy) return;

    const target = captureSelection();
    if (!target) {
      toast("Highlight some text in an editable field first.");
      return;
    }

    busy = true;
    const done = toast("Rewriting…", { sticky: true });

    try {
      const response = await chrome.runtime.sendMessage({
        type: "REFINE_TEXT",
        text: target.text
      });

      if (!response || !response.ok) {
        done((response && response.error) || "Rewrite failed.");
        return;
      }

      if (hasDrifted(target)) {
        done("Selection changed, so nothing was replaced.");
        return;
      }

      const replaced = replaceSelection(target, response.text);
      done(replaced ? "Rewritten." : "Could not replace the text here.");
    } catch (err) {
      done(err && err.message ? err.message : "Rewrite failed.");
    } finally {
      busy = false;
    }
  }

  // --- capture -------------------------------------------------------------

  function captureSelection() {
    const active = document.activeElement;

    if (isTextField(active)) {
      const { selectionStart: start, selectionEnd: end } = active;
      if (start == null || end == null || start === end) return null;
      const text = active.value.slice(start, end);
      if (!text.trim()) return null;
      return { kind: "field", element: active, start, end, text };
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const text = selection.toString();
    if (!text.trim()) return null;

    const range = selection.getRangeAt(0);
    const host = editableHost(range.commonAncestorContainer);
    if (!host) return null;

    return { kind: "editable", host, range: range.cloneRange(), text };
  }

  function isTextField(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    return FIELD_INPUT_TYPES.has((el.getAttribute("type") || "").toLowerCase());
  }

  function editableHost(node) {
    const el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    return el.isContentEditable ? el : null;
  }

  // The API call takes a moment; make sure the user hasn't typed over the
  // selection in the meantime before overwriting anything.
  function hasDrifted(target) {
    try {
      if (target.kind === "field") {
        return target.element.value.slice(target.start, target.end) !== target.text;
      }
      return target.range.toString() !== target.text;
    } catch {
      return true;
    }
  }

  // --- replacement ---------------------------------------------------------

  function replaceSelection(target, text) {
    return target.kind === "field"
      ? replaceInField(target, text)
      : replaceInEditable(target, text);
  }

  function replaceInField({ element, start, end }, text) {
    element.focus();
    element.setSelectionRange(start, end);

    // insertText keeps the browser's native undo stack intact.
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch {
      inserted = false;
    }

    if (!inserted) {
      // Fall back to writing the value through the native setter so frameworks
      // that patch the property (React and friends) still see the change.
      const proto =
        element.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      const next = element.value.slice(0, start) + text + element.value.slice(end);
      setter.call(element, next);
      element.setSelectionRange(start + text.length, start + text.length);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    return true;
  }

  function replaceInEditable({ host, range }, text) {
    host.focus();

    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch {
      inserted = false;
    }

    if (!inserted) {
      range.deleteContents();
      const fragment = textToFragment(text);
      const last = fragment.lastChild;
      range.insertNode(fragment);

      if (last) {
        const after = document.createRange();
        after.setStartAfter(last);
        after.collapse(true);
        selection.removeAllRanges();
        selection.addRange(after);
      }

      // Gmail and Outlook watch for input events to know the draft changed.
      host.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })
      );
    }

    return true;
  }

  function textToFragment(text) {
    const fragment = document.createDocumentFragment();
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (i > 0) fragment.appendChild(document.createElement("br"));
      if (line) fragment.appendChild(document.createTextNode(line));
    });
    return fragment;
  }

  // --- toast ---------------------------------------------------------------
  // Rendered inside a shadow root so the page's CSS cannot reach it, and the
  // page's scripts are unlikely to trip over it.

  let toastHost = null;
  let toastTimer = null;

  function toast(message, { sticky = false } = {}) {
    const bubble = ensureToast();
    bubble.textContent = message;
    toastHost.style.opacity = "1";

    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(hideToast, 3000);

    // Returned so a sticky toast can be settled with its final message.
    return (finalMessage) => {
      bubble.textContent = finalMessage;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(hideToast, 3000);
    };
  }

  function hideToast() {
    if (toastHost) toastHost.style.opacity = "0";
  }

  function ensureToast() {
    if (toastHost && toastHost.isConnected) {
      return toastHost.shadowRoot.querySelector(".bubble");
    }

    toastHost = document.createElement("div");
    toastHost.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "pointer-events:none",
      "opacity:0",
      "transition:opacity 150ms ease"
    ].join(";");

    const root = toastHost.attachShadow({ mode: "open" });
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.setAttribute("role", "status");
    bubble.setAttribute("aria-live", "polite");
    bubble.style.cssText = [
      "font:13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif",
      "color:#fff",
      "background:#1f2023",
      "padding:8px 12px",
      "border-radius:6px",
      "box-shadow:0 2px 10px rgba(0,0,0,.25)",
      "max-width:280px"
    ].join(";");

    root.appendChild(bubble);
    (document.body || document.documentElement).appendChild(toastHost);
    return bubble;
  }
})();
