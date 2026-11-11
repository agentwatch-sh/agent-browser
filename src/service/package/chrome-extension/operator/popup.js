// The popup. The logic is exported so a Node test can run it; the page wiring
// runs only where there is a document.
import {
  BOX_TEXT, boxHosts, domainOptions, fetchTargets, isBoxSite, queueSend, readableSites, siteOrigins, userChoices, visibleStatus,
} from "./send.js";

// The Send click. permissions.request is the first statement, before any
// await, so Chrome counts it as the user's gesture. Chrome closes this popup
// when it shows its permission dialog, so in the same task the send goes to
// storage.session, where the worker finds it once Chrome gives the access; a
// closing popup stops nothing. Only a popup that stays open sees a denial and
// reports it.
export async function onSendClick(chrome, ctx) {
  const asked = chrome.permissions.request({ origins: siteOrigins(ctx.domain) });
  const queued = Promise.resolve(queueSend(chrome, ctx)).catch(() => {});
  let granted = false;
  try {
    granted = await asked;
  } catch {
    granted = false;
  }
  await queued;
  if (granted) return;
  await chrome.storage.session.remove("pendingSend");
  await chrome.storage.session.set({
    lastSend: {
      state: "error", text: `Chrome did not give access to ${ctx.domain}.`, domain: ctx.domain, at: Date.now(),
    },
  });
}

function show(el, text, link) {
  el.replaceChildren(document.createTextNode(text));
  if (link) {
    const a = document.createElement("a");
    a.href = link;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = " Open the login page.";
    el.append(a);
  }
}

async function start() {
  const $ = (id) => document.getElementById(id);
  const status = $("status");
  const sendBtn = $("send");
  const domainSel = $("domain");
  const boxSel = $("box");
  const userSel = $("user");
  const userNote = $("user-note");
  const siteNote = $("site-note");
  let tab = null;
  let host = "";
  let boxes = [];

  // A domain that reaches a saved box's sign-in is never sent (the worker
  // refuses it too).
  const refreshSend = () => {
    const boxSite = Boolean(tab && domainSel.value && isBoxSite(domainSel.value, host, boxHosts(boxes)));
    if (tab) siteNote.textContent = boxSite ? BOX_TEXT : "";
    sendBtn.disabled = boxSite || !(tab && domainSel.value && boxSel.value && userSel.value);
  };
  const fill = (sel, values) => {
    sel.replaceChildren(...values.map((v) => Object.assign(document.createElement("option"), { value: v, textContent: v })));
  };

  let last = null;
  const showLast = () => {
    const v = visibleStatus(last, domainSel.value);
    if (v) show(status, v.text, v.link);
    else status.textContent = "";
  };
  ({ lastSend: last } = await chrome.storage.session.get("lastSend"));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.lastSend) {
      last = changes.lastSend.newValue;
      showLast();
    }
  });

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(active?.url ?? "");
    if (u.protocol === "https:" || u.protocol === "http:") host = u.hostname;
  } catch {
    host = "";
  }
  const { choices, chosen } = host ? await domainOptions(chrome, active.id, host) : { choices: [], chosen: "" };
  if (choices.length === 0) {
    siteNote.textContent = "Open the site you want to send in this tab first.";
  } else {
    tab = { tabId: active.id, url: active.url };
    fill(domainSel, choices);
    domainSel.value = chosen;
  }
  showLast();

  ({ boxes = [] } = await chrome.storage.local.get("boxes"));
  fill(boxSel, boxes);
  $("no-box").hidden = boxes.length > 0;
  $("add-box").addEventListener("click", () => chrome.runtime.openOptionsPage());

  async function loadUsers() {
    userNote.textContent = "";
    fill(userSel, []);
    refreshSend();
    if (!boxSel.value) return;
    const box = boxSel.value;
    const r = await fetchTargets(fetch, box);
    if (box !== boxSel.value) return;
    if (r.kind !== "ok") {
      show(userNote, r.text, r.link);
      return;
    }
    const choices = userChoices(r.users);
    fill(userSel, choices.map((c) => c.name));
    for (const [i, c] of choices.entries()) {
      if (!c.disabled) continue;
      userSel.options[i].disabled = true;
      userSel.options[i].title = c.reason;
    }
    // The first user that can be chosen is the selected one.
    const first = [...userSel.options].find((o) => !o.disabled);
    userSel.value = first ? first.value : "";
    const reasons = choices.filter((c) => c.disabled).map((c) => c.reason).join(" ");
    if (choices.length < r.users.length) {
      const login = `Log in to ${new URL(box).host} with your password first.`;
      show(userNote, reasons ? `${reasons} ${login}` : login, box + "/login?next=/browser");
    } else if (reasons) {
      userNote.textContent = reasons;
    }
    refreshSend();
  }
  boxSel.addEventListener("change", loadUsers);
  domainSel.addEventListener("change", () => {
    refreshSend();
    showLast();
  });
  userSel.addEventListener("change", refreshSend);
  await loadUsers();

  sendBtn.addEventListener("click", () => {
    sendBtn.disabled = true;
    onSendClick(chrome, {
      ...tab, domain: domainSel.value, box: boxSel.value, user: userSel.value,
    }).finally(refreshSend);
  });

  async function renderSites() {
    const list = $("sites");
    const granted = await chrome.permissions.getAll();
    const sites = readableSites(granted.origins ?? [], boxes);
    list.replaceChildren();
    $("no-sites").hidden = sites.length > 0;
    for (const origin of sites) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = origin;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Remove";
      btn.addEventListener("click", async () => {
        await chrome.permissions.remove({ origins: [origin] });
        await renderSites();
      });
      li.append(span, btn);
      list.append(li);
    }
  }
  await renderSites();
  refreshSend();
}

if (typeof document !== "undefined" && typeof chrome !== "undefined" && document.getElementById("send")) {
  start();
}
