// The test merchant's service worker (the variant worker; board ab-sta.8): when it starts, and at each fetch of a page
// that it controls, it says that it runs, with a request to the shop and one to the provider's host (worker-ping). It
// answers no fetch itself. TEST code: it holds no card value.
const pay = `${location.protocol}//pay.localhost${location.port ? `:${location.port}` : ""}`;
let n = 0;
const ping = () => { n++; return Promise.all([fetch(`/worker-ping?w=service&n=${n}`).catch(() => {}), fetch(`${pay}/worker-ping?w=service&n=${n}`, { mode: "no-cors" }).catch(() => {})]); };
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(Promise.all([self.clients.claim(), ping()])));
self.addEventListener("fetch", (e) => { if (!new URL(e.request.url).pathname.startsWith("/worker-ping")) e.waitUntil(ping()); });
