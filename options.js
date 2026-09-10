const DEFAULT_MODEL = "claude-sonnet-5";

const keyInput = document.getElementById("apiKey");
const modelSelect = document.getElementById("model");
const status = document.getElementById("status");

document.addEventListener("DOMContentLoaded", async () => {
  const { apiKey, model } = await chrome.storage.local.get(["apiKey", "model"]);
  if (apiKey) keyInput.value = apiKey;
  modelSelect.value = model || DEFAULT_MODEL;
});

document.getElementById("toggle").addEventListener("click", (event) => {
  const showing = keyInput.type === "text";
  keyInput.type = showing ? "password" : "text";
  event.target.textContent = showing ? "Show" : "Hide";
});

document.getElementById("save").addEventListener("click", async () => {
  const apiKey = keyInput.value.trim();
  if (!apiKey) {
    show("Enter an API key first.", true);
    return;
  }

  await chrome.storage.local.set({ apiKey, model: modelSelect.value });
  show("Saved.");
});

function show(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
  setTimeout(() => {
    status.textContent = "";
    status.classList.remove("error");
  }, 2500);
}
