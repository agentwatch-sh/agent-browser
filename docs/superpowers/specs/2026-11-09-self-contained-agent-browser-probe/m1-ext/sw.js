// Probe only (board ab-v16.93, M1). The extension connects to its native host and answers each ping with a pong
// that carries the same id and payload. After a disconnect it connects again after 1 s (as agent/link.js does).
const HOST = "probe.selfcontained.m1";
let port = null;
function connect() {
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener((m) => {
    if (m && m.t === "ping") port.postMessage({ t: "pong", id: m.id, pad: m.pad ?? "" });
  });
  port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 1000); });
  port.postMessage({ t: "hello", id: chrome.runtime.id, at: Date.now() });
}
connect();
