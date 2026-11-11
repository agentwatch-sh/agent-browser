// The options page: the boxes the sender may send to. The logic is exported so
// a Node test can run it; the page wiring runs only where there is a document.

const LOCAL_HOSTS = (h) => h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1";

export function parseBoxOrigin(text) {
  const s = String(text ?? "").trim();
  if (s === "") return { ok: false, text: "Type the web viewer address of your box." };
  let u;
  try {
    u = new URL(s.includes("://") ? s : "https://" + s);
  } catch {
    return { ok: false, text: "That address is not valid." };
  }
  if (u.hostname === "") return { ok: false, text: "That address is not valid." };
  if (u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HOSTS(u.hostname))) {
    return { ok: true, origin: u.origin };
  }
  return { ok: false, text: "Use an https address." };
}

export async function addBox(chrome, text) {
  const parsed = parseBoxOrigin(text);
  if (!parsed.ok) return parsed;
  const { origin } = parsed;
  // The permission request is the first call: it needs the user's click.
  const granted = await chrome.permissions.request({ origins: [origin + "/*"] });
  if (!granted) return { ok: false, text: `Chrome did not give access to ${new URL(origin).host}.` };
  const { boxes = [] } = await chrome.storage.local.get("boxes");
  if (!boxes.includes(origin)) boxes.push(origin);
  await chrome.storage.local.set({ boxes });
  return { ok: true, origin };
}

export async function removeBox(chrome, origin) {
  const { boxes = [] } = await chrome.storage.local.get("boxes");
  await chrome.storage.local.set({ boxes: boxes.filter((b) => b !== origin) });
  await chrome.permissions.remove({ origins: [origin + "/*"] });
  return { ok: true };
}

async function render() {
  const list = document.getElementById("boxes");
  const { boxes = [] } = await chrome.storage.local.get("boxes");
  list.replaceChildren();
  document.getElementById("none").hidden = boxes.length > 0;
  for (const origin of boxes) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = origin;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Remove";
    btn.addEventListener("click", async () => {
      await removeBox(chrome, origin);
      await render();
    });
    li.append(span, btn);
    list.append(li);
  }
}

if (typeof document !== "undefined" && typeof chrome !== "undefined" && document.getElementById("add-form")) {
  const input = document.getElementById("box-url");
  const status = document.getElementById("status");
  document.getElementById("add-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    status.textContent = "";
    // addBox calls permissions.request before any await.
    addBox(chrome, input.value).then(async (r) => {
      if (r.ok) input.value = "";
      else status.textContent = r.text;
      await render();
    });
  });
  render();
}
