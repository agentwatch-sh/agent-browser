// The sender's service worker. The popup leaves a send in storage.session
// and may close at once (Chrome closes it when it shows the permission
// dialog). This worker waits for the site's access, then does the read, the
// size check and the POST. Both events below also wake a stopped worker.
import { resumeSend } from "./send.js";

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.pendingSend && changes.pendingSend.newValue) resumeSend(chrome, fetch);
});

// The operator's Allow in Chrome's dialog.
chrome.permissions.onAdded.addListener(() => {
  resumeSend(chrome, fetch);
});
