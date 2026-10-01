# Email Polisher

A Chrome extension (Manifest V3) that rewrites highlighted text in place. Highlight
something in a compose box, press the hotkey, and the selection is replaced with a
tightened version from the Claude API. No popup, no click-through.

## Flow

1. Highlight text in an editable field (`<textarea>`, `<input>`, or a `contenteditable`
   element such as Gmail's compose box).
2. Press **Ctrl+Shift+E** (**Cmd+Shift+E** on macOS).
3. The content script captures the selection and sends it to the background service
   worker, which calls the Claude API.
4. The rewrite replaces the selection in place.

Anything that goes wrong (no selection, non-editable field, API error) shows a small
toast in the corner and leaves the page untouched.

## Install

1. Open `chrome://extensions/` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this directory.
3. Open the extension's **Details → Extension options** and paste an Anthropic API key.
4. Optionally rebind the shortcut at `chrome://extensions/shortcuts`.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest: permissions, command binding, content script registration |
| `background.js` | Service worker: holds the API key, calls the Claude API, relays the rewrite |
| `content.js` | Selection capture, in-place replacement, toast |
| `options.html` / `options.js` | API key and model settings |
| `test/` | Browser tests for selection capture and replacement |

## How it works

**Trigger.** The shortcut is registered through `chrome.commands`, so Chrome delivers it
even on pages that swallow keystrokes, and users can rebind it. The service worker sends
a message to the active tab; if the content script isn't loaded (the extension was
installed or reloaded after the page), it injects `content.js` once and retries.

**Capture and replacement.** Three cases:

- `<textarea>` / `<input>`: read `selectionStart` / `selectionEnd` off the active element.
- `contenteditable`: read the `Range` from `window.getSelection()`.
- Anything else: no-op with a toast.

Replacement prefers `document.execCommand("insertText")` in both cases. It is the closest
thing to the user typing, so it keeps the browser's undo stack intact and fires the native
`input` events Gmail and Outlook listen for. When it fails, the fallbacks are explicit:
for fields, the value goes through the native `value` setter (so frameworks that patch the
property still notice) followed by synthetic `input` and `change` events; for
`contenteditable`, `Range.deleteContents()` + `Range.insertNode()` with newlines converted
to `<br>`, followed by a synthetic `InputEvent`.

Because the API call takes a second or two, the captured selection is re-checked
immediately before the write. If the text under it changed in the meantime, the rewrite is
dropped rather than pasted over whatever the user typed.

The content script runs in all frames but only the frame holding focus acts on the hotkey,
so an Outlook-style iframed editor works without double-rewriting.

**API call.** The service worker owns the key, so it never enters page context. It posts to
`https://api.anthropic.com/v1/messages` with `anthropic-dangerous-direct-browser-access:
true` (required for browser-originated calls), the fixed rewrite prompt as `system`, and
the selection as the user message. Requests run at `effort: "low"` to keep the round trip
short, and time out after 45 seconds. Every `text` block in the response is joined rather
than reading `content[0]`, since adaptive thinking can put a thinking block first.

Default model is `claude-haiku-4-5`; Sonnet 5 and Opus 5 are selectable in options.
`output_config.effort` is sent only for the models that accept it, since Haiku 4.5 rejects
it with a 400.

## Tests

`test/selection.test.mjs` drives `content.js` in a real Chromium against a stubbed
`chrome.*` API and checks the parts most likely to break on a real page: replacement in a
`<textarea>`, an `<input>`, and a `contenteditable`; that an `input` event reaches the host
page (what Gmail listens for); that newlines survive into a `contenteditable`; that no
selection, a non-editable selection, and an API error all leave the page untouched; and
that a selection edited mid-flight is not overwritten.

```
npm install
npx playwright install chromium
npm test
```

Set `PLAYWRIGHT_CHROMIUM_PATH` to point at a Chromium that Playwright did not install.

## The rewrite prompt

Fixed, in `background.js`, and run as two passes in one call.

**Pass 1 strips AI writing tells,** condensed from the `humanize-writing` skill and ordered
strongest first: not-X-but-Y contrasts, one-line closers and dramatic fragments, sayings
that sound deep, staged run-ups, arguing with objections nobody raised, chatbot residue,
forced triads, inflated significance and sales language, shallow -ing riders, vague
connection, verbs that avoid *is/are/has*, repeated sentence openings, stacked qualifiers,
decoration, and background re-explained to a reader who already has it.

**Pass 2 tightens with Orwell's six rules:** no stale figures of speech, short words over
long, cut any word that can go, active over passive, plain English over jargon, and break
those rules before writing anything barbarous.

**Hard constraints override both:** no em dashes or en dashes anywhere; keep every primary
fact (recipient, the ask, dates, numbers, names, commitments, next step) and invent none;
match the original's tone and never exceed its length; keep the details that carry the
writer's voice; leave an already-clean passage nearly alone; return only the rewritten
text.

## Privacy

The API key lives in `chrome.storage.local` on this device and is never synced. Selected
text is sent to the Anthropic API when you press the shortcut, and nowhere else. Nothing
is logged or stored.

## Known limits

- Only works where the browser can edit text. Google Docs draws its own canvas and is not
  supported.
- Rich formatting inside a selection is flattened to plain text.
- One rewrite at a time per frame.

## Future work

- Undo: cache the original text so a second hotkey press reverts the rewrite.
- Per-site enable/disable toggle.
- Inline progress indicator at the selection rather than a corner toast.
- Streaming the rewrite in so long selections update as they arrive.
