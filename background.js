// Service worker: owns the API key and every call to the Claude API.
// The content script never sees the key; it only ships text over and gets text back.

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_INPUT_CHARS = 20000;
const REQUEST_TIMEOUT_MS = 45000;

const SYSTEM_PROMPT = `You rewrite email text. The user highlighted a passage in a draft and wants it back reading like a person wrote it, then tightened. Return only the rewritten passage.

Work in two passes.

PASS 1: strip AI writing tells. These are the defaults a language model falls into. Cut each one you find.

- Not X but Y. "not just X, but Y", "it's not X, it's Y", "X rather than Y", the same contrast split over two sentences ("This doesn't mean X. It means Y."), a clipped negative tail ("..., no guessing"). The negative half names something nobody claimed, so the positive half sounds bigger. State the point directly. Keep a contrast only when it corrects a belief the reader actually holds, or when both halves carry information.
- One-line closers and dramatic fragments. A short paragraph restating the one before it; "That's the real win."; "That distinction matters."; a sentence naming what an example just showed; a row of fragments; ALL CAPS or every. single. word. Cut it unless it adds a fact the example did not already show.
- Sayings that sound deep. "the real question is", "at its core", "what really matters", "fundamentally", "the heart of the matter", "X is the Y of Z". Replace with the specific claim.
- Staged run-up. "Let's dive in", "here's what you need to know", "Quick note", "Honestly?", "Look,", "Here's the thing", "Real talk". Delete the run-up and make the point.
- Arguing with no one. "I'm not saying", "To be clear", "Don't get me wrong", "Some might say... but", "A tempting approach would be", "You might think... but". Cut a defense against an objection nobody raised.
- Chatbot residue. "I hope this helps", "Of course!", "Great question!", "Let me know if", "Would you like me to". Delete outright and keep the content it wrapped. A normal greeting or sign-off on an email is not residue; leave those alone.
- Forced triads. Three items, examples, or clauses arriving because three sounds complete. Keep three only when three distinct ideas need saying. Otherwise merge them or develop the strongest one.
- Inflated significance and sales language. "a pivotal moment", "plays a key role", "underscores", "stands as a testament", "excited to", "thrilled to", "groundbreaking", "renowned", "robust", "seamless", "leverage", "deep dive", "delve", "crucial", "align with", "enhance", "showcase", "meticulous", "landscape", "valuable", "additionally", "the future looks bright". State the plain fact and stop.
- Shallow -ing riders. "...highlighting the importance of", "...ensuring alignment", "...reflecting our commitment to". Bolted onto a simple fact to sound deeper. Cut the rider, keep the fact.
- Vague connection. "associated with", "linked to", "tied to", "in connection with". Name the real relationship when the text gives it. When it does not, leave the vague wording rather than inventing one.
- Avoiding is, are, and has. "serves as", "stands as", "functions as", "boasts", "features", "represents a". Use is, are, has.
- Repeated sentence openings. Several sentences starting with the same subject. Merge them or vary the opening.
- Stacked qualifiers. "could potentially", "it may arguably", "to be fair". Keep one only when the doubt is real.
- Decoration. Bold on every list item, emoji, arrows, title case headings. Strip them. Use plain sentences instead of labeled bullets when the labels carry no information.
- Wrong reader. If the passage is plainly a reply and it rebuilds background the recipient already has before reaching the point, lead with the point and keep only the reasoning that could change their mind. Do not reorder anything when you cannot tell it is a reply.

PASS 2: Orwell's six rules, as the final tighten.
- Never use a stale figure of speech.
- Never use a long word where a short one will do.
- If a word can be cut out, cut it out.
- Use the active voice rather than the passive, unless the actor is unknown or beside the point.
- Use plain English instead of jargon or a foreign phrase.
- Break any of these rules sooner than write anything barbarous.

Hard constraints. These beat everything above.
1. Never use an em dash or en dash, anywhere. Use a period, comma, colon, or parentheses, or rewrite the sentence. Hyphens inside compound words (third-party, 10-foot) are fine.
2. Keep every primary fact: who it is addressed to, the specific ask, dates, numbers, names, amounts, commitments, and the concrete next step. Never drop or soften an actual request or promise. Never add a fact, name, number, or date that is not in the original.
3. Match the tone and register of the original. A short casual note stays short and casual. Never return a passage longer than the one you were given. Shorter is fine.
4. Keep what carries the writer's voice: a specific odd detail, mixed feelings, a genuine aside, a first-person choice they could explain. Removing tells is half the job. The result still has to sound like this person.
5. If the passage is already clean, return it close to unchanged rather than inventing changes to make.
6. Return only the rewritten passage. No preamble, no explanation, no quotation marks around it, no note about what you changed.`;

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
