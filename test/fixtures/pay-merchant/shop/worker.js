// The test merchant's dedicated worker (the variant worker; board ab-sta.8): each second it says that it runs, with a
// request to the shop and one to the provider's host (worker-ping). TEST code: it holds no card value.
const pay = `${location.protocol}//pay.localhost${location.port ? `:${location.port}` : ""}`;
let n = 0;
const ping = () => { n++; fetch(`/worker-ping?w=dedicated&n=${n}`).catch(() => {}); fetch(`${pay}/worker-ping?w=dedicated&n=${n}`, { mode: "no-cors" }).catch(() => {}); };
ping();
setInterval(ping, 1000);
