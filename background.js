// Service worker: owns the API key and every call to the Claude API.
// The content script never sees the key; it only ships text over and gets text back.

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_INPUT_CHARS = 20000;
const REQUEST_TIMEOUT_MS = 45000;

const SYSTEM_PROMPT = `Rewrite the given email text for clarity, concision, and fluency. Rules:

1. Never use an em dash (—). If a sentence wants one, split it into two sentences or use a comma, colon, or parentheses instead.
2. Apply Orwell's six rules for writing: avoid clichéd figures of speech; use short words over long ones; cut any word that can be cut; prefer active voice over passive; avoid jargon or foreign phrases when a plain English word works; break these rules before writing anything barbarous.
3. Preserve every primary detail from the original: who it's addressed to, the specific ask, any dates/numbers/names, and the concrete next step. Tighten language, but never drop or soften an actual request, commitment, or fact.
4. Match the tone and length of the original. Don't pad a short, casual email into something longer or more formal.
5. Return ONLY the rewritten text. No preamble, no explanation, no quotation marks around it.`;

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "refine-selection") return;

  let tabId = tab && tab.id;
  if (tabId == null) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = active && active.id;
  }
  if (tabId == null) return;

  try {
    await chrome.tabs.sendMessage(tabId, { type: "REFINE_SELECTION" });
  } catch (err) {
    // The content script isn't there yet: the extension was installed or reloaded
    // after this page loaded. Inject it once and retry. Any other failure is not
    // worth a retry, which could rewrite the same selection twice.
    if (!/Receiving end does not exist/i.test(err.message || "")) {
      console.warn("Email Polisher: could not deliver the shortcut.", err);
      return;
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["content.js"]
      });
      await chrome.tabs.sendMessage(tabId, { type: "REFINE_SELECTION" });
    } catch (injectErr) {
      // Restricted page (chrome://, the Web Store, a PDF viewer). Nothing to do.
      console.warn("Email Polisher: cannot reach this page.", injectErr);
    }
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "REFINE_TEXT") return false;

  refine(message.text)
    .then((text) => sendResponse({ ok: true, text }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true; // keep the message channel open for the async reply
});

async function refine(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Nothing to rewrite.");
  }
  if (text.length > MAX_INPUT_CHARS) {
    throw new Error(`Selection is too long (${text.length} characters, limit ${MAX_INPUT_CHARS}).`);
  }

  const { apiKey, model } = await chrome.storage.local.get(["apiKey", "model"]);
  if (!apiKey) {
    throw new Error("No API key set. Add one in the extension options.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Required for calls made from a browser context, including an extension worker.
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        max_tokens: 16000,
        // Low effort keeps the round trip short; a rewrite needs little deliberation.
        output_config: { effort: "low" },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: text }]
      })
    });
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Claude took too long to respond.");
    throw new Error("Could not reach the Claude API.");
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`Claude API error ${response.status}: ${await errorDetail(response)}`);
  }

  const data = await response.json();

  if (data.stop_reason === "refusal") {
    throw new Error("Claude declined to rewrite that text.");
  }

  // Adaptive thinking can put a thinking block first, so take every text block
  // rather than assuming content[0].
  const rewritten = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!rewritten) throw new Error("Claude returned an empty rewrite.");
  if (data.stop_reason === "max_tokens") {
    throw new Error("The rewrite was cut off before it finished.");
  }

  return rewritten;
}

async function errorDetail(response) {
  try {
    const body = await response.json();
    return (body && body.error && body.error.message) || response.statusText;
  } catch {
    return response.statusText || "unknown error";
  }
}
