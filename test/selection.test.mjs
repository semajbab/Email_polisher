import { chromium } from "playwright";
import path from "path";

// Drives content.js in a real browser against a stubbed chrome.* API, so the
// selection capture and in-place replacement paths are exercised for real.

const dir = path.dirname(new URL(import.meta.url).pathname);
// Set PLAYWRIGHT_CHROMIUM_PATH to use a Chromium that Playwright did not install.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
const results = [];
const check = (name, pass, detail = "") => results.push({ name, pass, detail });

await page.goto("file://" + path.join(dir, "harness.html"));

const toastText = () =>
  page.evaluate(() => {
    const host = [...document.body.children].find((el) => el.shadowRoot);
    return host ? host.shadowRoot.querySelector(".bubble").textContent : null;
  });

// 1. textarea
await page.evaluate(() => {
  const ta = document.getElementById("ta");
  ta.focus();
  ta.setSelectionRange(0, 8); // "Hi Bob, "
  window.__fire();
});
await page.waitForTimeout(200);
check(
  "textarea replaced in place",
  (await page.inputValue("#ta")) === "REWRITTENI wanted to reach out to you in order to ask about the report.",
  await page.inputValue("#ta")
);
check("textarea sent the selected text", (await page.evaluate(() => window.__sent[0].text)) === "Hi Bob, ");

// 2. contenteditable + input event visibility (what Gmail listens for)
await page.evaluate(() => {
  window.__inputEvents = 0;
  document.getElementById("ce").addEventListener("input", () => window.__inputEvents++);
  const ce = document.getElementById("ce");
  ce.focus();
  const range = document.createRange();
  range.setStart(ce.firstChild, 0);
  range.setEnd(ce.firstChild, 9); // "Hi Carol,"
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  window.__fire();
});
await page.waitForTimeout(200);
check(
  "contenteditable replaced in place",
  (await page.textContent("#ce")) === "REWRITTEN just following up on the invoice from March 3rd.",
  await page.textContent("#ce")
);
check("input event fired for the host page", (await page.evaluate(() => window.__inputEvents)) > 0);

// 3. multi-line rewrite into contenteditable
await page.evaluate(() => {
  window.__reply = { ok: true, text: "Line one\nLine two" };
  const ce = document.getElementById("ce");
  ce.focus();
  const range = document.createRange();
  range.selectNodeContents(ce);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  window.__fire();
});
await page.waitForTimeout(200);
check(
  "newlines survive into contenteditable",
  (await page.textContent("#ce")).includes("Line one") && (await page.textContent("#ce")).includes("Line two"),
  await page.textContent("#ce")
);

// 4. input element
await page.evaluate(() => {
  window.__reply = { ok: true, text: "Please do this soon." };
  const el = document.getElementById("in");
  el.focus();
  el.setSelectionRange(0, el.value.length);
  window.__fire();
});
await page.waitForTimeout(200);
check("input element replaced", (await page.inputValue("#in")) === "Please do this soon.", await page.inputValue("#in"));

// 5. no selection -> toast, no API call
const before = await page.evaluate(() => window.__sent.length);
await page.evaluate(() => {
  getSelection().removeAllRanges();
  document.getElementById("in").blur();
  document.body.focus();
  window.__fire();
});
await page.waitForTimeout(100);
check("no selection makes no API call", (await page.evaluate(() => window.__sent.length)) === before);
check("no selection shows a toast", (await toastText()).includes("Highlight some text"), await toastText());

// 6. non-editable selection -> no-op
await page.evaluate(() => {
  const range = document.createRange();
  range.selectNodeContents(document.getElementById("plain"));
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  window.__fire();
});
await page.waitForTimeout(100);
check("non-editable selection makes no API call", (await page.evaluate(() => window.__sent.length)) === before);
check("non-editable text is untouched", (await page.textContent("#plain")) === "Not editable text here.");

// 7. drift guard: text changes mid-flight
await page.evaluate(async () => {
  window.__reply = { ok: true, text: "SHOULD-NOT-LAND" };
  const ta = document.getElementById("ta");
  ta.value = "Alpha beta gamma";
  ta.focus();
  ta.setSelectionRange(0, 5);
  window.__fire();
  await new Promise((r) => setTimeout(r, 2));
  ta.value = "Totally different text now";
});
await page.waitForTimeout(200);
check(
  "drifted selection is not overwritten",
  !(await page.inputValue("#ta")).includes("SHOULD-NOT-LAND"),
  await page.inputValue("#ta")
);
check("drift shows a toast", (await toastText()).includes("Selection changed"), await toastText());

// 8. API error surfaces in the toast, page untouched
await page.evaluate(() => {
  window.__reply = { ok: false, error: "Claude API error 401: invalid x-api-key" };
  const ta = document.getElementById("ta");
  ta.value = "Some draft text";
  ta.focus();
  ta.setSelectionRange(0, 4);
  window.__fire();
});
await page.waitForTimeout(200);
check("API error keeps the text intact", (await page.inputValue("#ta")) === "Some draft text");
check("API error is shown", (await toastText()).includes("401"), await toastText());

await browser.close();

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : "  -> got: " + JSON.stringify(r.detail)}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
