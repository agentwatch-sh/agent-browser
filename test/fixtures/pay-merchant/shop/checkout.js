// The test merchant's checkout (test/fixtures/pay-merchant/server.ts): the variant comes from this script's
// data-variant. The pay button asks the provider's frame to charge (postMessage), and the frame's answer moves the page to
// its confirmation, shows the decline, or opens the bank's step. As shops do between their tabs, the page tells its other
// tabs of the origin each step of the frame (BroadcastChannel "shop-sync": the step's name only); the live check's agent
// listens there (board ab-sta.8). TEST code: no card value ever reaches this page.
(() => {
  const variant = document.currentScript.dataset.variant || "base";
  const port = location.port ? `:${location.port}` : "";
  const originOf = (host) => `${location.protocol}//${host}${port}`;
  const frame = document.getElementById("card-frame");
  const frameOrigin = frame ? originOf(frame.dataset.host || "pay.localhost") : null;
  if (frame) frame.src = `${frameOrigin}/fields.html?variant=${encodeURIComponent(variant)}`;
  const total = document.getElementById("total"), status = document.getElementById("status"), button = document.getElementById("pay");
  // A countdown: no part of the page's order.
  let left = 600;
  const timer = document.getElementById("timer");
  setInterval(() => { if (left > 0) left--; if (timer) timer.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`; }, 1000);
  // The variant worker: a dedicated worker and a service worker of the shop (worker.js, sw.js).
  if (variant === "worker") {
    try { new Worker("worker.js"); } catch (e) { /* no worker */ }
    if (navigator.serviceWorker) navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  if (variant === "session" && !sessionStorage.getItem("cart")) {
    document.getElementById("order").textContent = "Your cart is empty.";
    if (frame) frame.remove();
    button.remove();
    return;
  }
  const confirmations = { fee: "confirmation-fee.html", last4: "confirmation-last4.html", "last4-order": "confirmation-last4-order.html" };
  let sync = null;
  try { sync = new BroadcastChannel("shop-sync"); } catch (e) { sync = null; }
  window.addEventListener("message", (ev) => {
    if (ev.origin !== frameOrigin || !ev.data || typeof ev.data !== "object") return;
    if (sync && typeof ev.data.op === "string") sync.postMessage({ op: ev.data.op, variant });
    if (ev.data.op === "typed" && variant === "total-change") { total.textContent = "Total: $54.00"; return; }
    if (ev.data.op !== "charged") return;
    if (!ev.data.ok) { status.textContent = "Payment failed: your card was declined."; button.disabled = false; return; }
    if (ev.data.bank) {
      const bank = document.createElement("iframe");
      bank.id = "bank-frame";
      bank.title = "Your bank";
      bank.width = "440";
      bank.height = "300";
      bank.src = `${originOf("bank.localhost")}/3ds.html`;
      document.body.append(bank);
      return;
    }
    // The variant after-press: after the charge the page calls a host outside the act's rules of the press (other.localhost),
    // waits for its answer, then moves to the confirmation (the act's rules must grow for it).
    if (variant === "after-press") {
      fetch(`${originOf("other.localhost")}/after-press.html`, { mode: "no-cors" }).catch(() => {}).finally(() => { location.href = "confirmation.html"; });
      return;
    }
    const last4 = (variant === "last4" || variant === "last4-order") && /^\d{4}$/.test(String(ev.data.last4)) ? `#last4=${ev.data.last4}` : "";
    location.href = (confirmations[variant] || "confirmation.html") + last4;
  });
  button.addEventListener("click", () => {
    if (variant === "fee") {
      const fee = document.createElement("li");
      fee.textContent = "Card fee: $3.00";
      document.getElementById("lines").append(fee);
      total.textContent = "Total: $54.00";
    }
    if (!frame) { location.href = "confirmation.html"; return; }
    button.disabled = true;
    status.textContent = "Paying...";
    frame.contentWindow.postMessage({ op: "charge" }, frameOrigin);
  });
})();
