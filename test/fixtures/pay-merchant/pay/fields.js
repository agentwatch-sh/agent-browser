// The test payment provider's hosted card fields (pay.localhost; test/fixtures/pay-merchant/server.ts). The shop asks
// for a charge with postMessage; the frame sends the fields to its own API (POST /charge, the provider's origin) and
// answers the shop with the result and, as real providers do, the card's last four digits. TEST code: no card number.
(() => {
  const variant = new URLSearchParams(location.search).get("variant") || "base";
  const port = location.port ? `:${location.port}` : "";
  const shop = `${location.protocol}//shop.localhost${port}`;
  const save = document.getElementById("save");
  // The variant keep: a save-card box that cannot be unticked.
  if (variant === "keep") { save.disabled = true; save.parentElement.lastChild.textContent = " Your card will be saved for future purchases"; }
  let typed = false;
  for (const el of document.querySelectorAll("input:not([type=checkbox])")) {
    el.addEventListener("input", () => { if (!typed) { typed = true; parent.postMessage({ op: "typed" }, shop); } });
  }
  window.addEventListener("message", async (ev) => {
    if (ev.origin !== shop || !ev.data || ev.data.op !== "charge") return;
    const value = (id) => document.getElementById(id).value;
    const number = value("cc-number").replace(/\D/g, "");
    const body = new URLSearchParams({ number, exp: value("cc-exp"), csc: value("cc-csc"), name: value("cc-name"), postal: value("postal"), save: save.checked ? "1" : "0" });
    const r = await fetch(`/charge?variant=${encodeURIComponent(variant)}`, { method: "POST", body }).then((x) => x.json()).catch(() => ({ ok: false, error: "The payment failed." }));
    document.getElementById("error").textContent = r.ok ? "" : String(r.error || "The payment failed.");
    parent.postMessage({ op: "charged", ok: r.ok === true, bank: r.bank === true, last4: r.ok === true ? number.slice(-4) : null }, shop);
  });
})();
