// The local test page of the press and hold (board ab-t30.34; C11, the press and hold): a button that copies the public
// rules of a press-and-hold check (docs/research/2026-11-26-press-and-hold-check.md, section 1): a random fill time of 1
// to 10 s shown as a bar, a drain at a release before the fill is full, and a check mark at the full fill. The button is
// on the page (#hold-main), in a cross-origin frame of a second local site (/frame, on FRAME_HOST), and in a closed shadow
// root (#hold-shadow, a host with the role button: the snapshot gives the host a ref, and no ref inside the root). No
// vendor code: the page's own small script.
//
// Each widget logs every event of its button: its type, isTrusted, the pressure, the buttons, the point, the timeStamp,
// the coalesced count, the repeat; and its states (the press, the done state, the release after it or before it). It
// sends its log to its own origin's /log/<id> at each release and at the done state, so the check reads the logs from
// the server and puts nothing into the page during a hold. `?fill=<ms>` fixes the fill time (the Playwright row).

/** The second local site of the frame (Chrome maps it to 127.0.0.1 with --host-resolver-rules; the scope's list names it). */
export const FRAME_HOST = "hold-frame.test";
export const MAIN_HOST = "app.localhost";

/** One event of a widget's log. */
export type HoldEvent = { type: string; trusted: boolean; pressure: number | null; buttons: number | null; x: number | null; y: number | null; t: number; coalesced: number | null; repeat: boolean | null };
/** A widget's log: its fill time, its events and its states (`down` with its point, `done`, `released-after-done`, `released-early`, `drained`). */
export type HoldLog = { id: string; fillMs: number; events: HoldEvent[]; states: { s: string; t: number; x?: number; y?: number }[] };

const STYLE = `.hold{position:relative;width:320px;height:64px;border:2px solid #345;border-radius:8px;background:#eef2f6;font:600 18px sans-serif;color:#123;overflow:hidden;user-select:none;cursor:pointer;padding:0}
.hold .bar{position:absolute;left:0;top:0;bottom:0;width:0;background:#7ab}
.hold .label{position:relative}
.hold .mark{position:relative;margin-left:8px;color:#063}
.hold .mark[hidden]{display:none}
.hold .time{position:absolute;right:6px;bottom:2px;font:12px monospace;color:#345}`;
const BUTTON_HTML = (label: string) => `<span class="bar"></span><span class="label">${label}</span><span class="mark" hidden>&#10003;</span><span class="time"></span>`;

/** The widget's script: `widget(button, id)` (the button's own elements are its children). */
const WIDGET = `function widget(btn, id) {
  const q = new URLSearchParams(location.search);
  const fillMs = Number(q.get('fill')) || Math.round(1000 + Math.random() * 9000);
  const bar = btn.querySelector('.bar'), mark = btn.querySelector('.mark'), label = btn.querySelector('.label');
  btn.querySelector('.time').textContent = (fillMs / 1000).toFixed(1) + ' s';
  btn.dataset.fill = String(fillMs);
  const log = { id, fillMs, events: [], states: [] };
  const rec = (e) => log.events.push({ type: e.type, trusted: e.isTrusted, pressure: typeof e.pressure === 'number' ? e.pressure : null, buttons: typeof e.buttons === 'number' ? e.buttons : null,
    x: typeof e.clientX === 'number' ? e.clientX : null, y: typeof e.clientY === 'number' ? e.clientY : null, t: Math.round(e.timeStamp * 100) / 100,
    coalesced: typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents().length : null, repeat: typeof e.repeat === 'boolean' ? e.repeat : null });
  for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave', 'mousedown', 'mousemove', 'mouseup', 'click', 'dragstart', 'keydown', 'keyup', 'touchstart', 'contextmenu']) btn.addEventListener(type, rec, true);
  const send = () => { fetch('/log/' + id, { method: 'POST', body: JSON.stringify(log), keepalive: true }).catch(() => {}); };
  let held = false, done = false, level = 0, from = 0, raf = 0, last = 0;
  const draw = () => { bar.style.width = (level * 100).toFixed(3) + '%'; };
  const tick = (now) => {
    const dt = last ? now - last : 16; last = now;
    if (held && !done) {
      level = Math.min(1, (performance.now() - from) / fillMs);
      if (level >= 1) { done = true; mark.hidden = false; label.textContent = 'Verified'; log.states.push({ s: 'done', t: Math.round(performance.now() * 100) / 100 }); send(); }
    } else if (!held && !done && level > 0) {
      level = Math.max(0, level - dt / (fillMs / 2));
      if (level === 0) log.states.push({ s: 'drained', t: Math.round(performance.now() * 100) / 100 });
    }
    draw();
    raf = (held && !done) || (!held && !done && level > 0) ? requestAnimationFrame(tick) : 0;
    if (!raf) last = 0;
  };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || done) return;
    held = true; from = performance.now() - level * fillMs;
    log.states.push({ s: 'down', t: Math.round(e.timeStamp * 100) / 100, x: e.clientX, y: e.clientY });
    if (!raf) raf = requestAnimationFrame(tick);
  });
  const up = (e) => {
    if (!held) return;
    held = false;
    log.states.push({ s: done ? 'released-after-done' : 'released-early', t: Math.round(e.timeStamp * 100) / 100 });
    if (!done && !raf) raf = requestAnimationFrame(tick);
    send();
  };
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
}`;

/**
 * The view's log of a document (review of board ab-t30.34, I3): each `resize`, `visualViewport` `resize` and `scroll`,
 * change of a `matchMedia` query (the width, the height, the resolution and the orientation as they are at the load),
 * and each change of the window's size, the device pixel ratio or the visual viewport that a poll at each frame sees.
 * A capture with a clip that changed the page's view for the capture would show here. Sent to /log/view-<name>.
 */
const VIEW = (name: string) => `(function () {
  const log = { id: 'view-${name}', events: [] };
  const vv = window.visualViewport;
  const key = () => innerWidth + 'x' + innerHeight + '@' + devicePixelRatio + (vv ? ' vv ' + vv.width + 'x' + vv.height + '@' + vv.scale + '+' + vv.offsetLeft + ',' + vv.offsetTop : '');
  const send = () => { fetch('/log/view-${name}', { method: 'POST', body: JSON.stringify(log), keepalive: true }).catch(() => {}); };
  const rec = (type) => { log.events.push({ type, t: Math.round(performance.now() * 100) / 100, view: key() }); send(); };
  addEventListener('resize', () => rec('resize'));
  addEventListener('scroll', () => rec('scroll'));
  if (vv) { vv.addEventListener('resize', () => rec('vv-resize')); vv.addEventListener('scroll', () => rec('vv-scroll')); }
  const qs = ['(min-width: ' + innerWidth + 'px)', '(max-width: ' + (innerWidth - 1) + 'px)', '(min-height: ' + innerHeight + 'px)', '(max-height: ' + (innerHeight - 1) + 'px)',
    '(resolution: ' + devicePixelRatio + 'dppx)', '(orientation: ' + (innerWidth >= innerHeight ? 'landscape' : 'portrait') + ')'];
  for (const q of qs) matchMedia(q).addEventListener('change', () => rec('mq ' + q));
  let last = key();
  const poll = () => { const k = key(); if (k !== last) { last = k; rec('poll'); } requestAnimationFrame(poll); };
  requestAnimationFrame(poll);
  log.start = last;
  send();
})();`;

/** A document's view log (VIEW). */
export type ViewLog = { id: string; start: string; events: { type: string; t: number; view: string }[] };

/** The top page: the button on the page, the frame of the second site, and the closed shadow root. */
export function mainPage(port: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>press and hold of ${MAIN_HOST}</title><style>body{margin:24px;font:16px sans-serif}${STYLE}
iframe{width:400px;height:120px;border:1px solid #999;display:block;margin:16px 0}
#hold-shadow{display:block;width:324px;height:68px;margin-top:16px}</style></head><body>
<h1>Press and hold</h1>
<button class="hold" id="hold-main" aria-label="Press &amp; Hold (main)">${BUTTON_HTML("Press &amp; Hold")}</button>
<iframe title="hold frame" src="http://${FRAME_HOST}:${port}/frame"></iframe>
<div id="hold-shadow" role="button" tabindex="0" aria-label="Press &amp; Hold (shadow)"></div>
<script>${WIDGET}
widget(document.getElementById('hold-main'), 'main');
const host = document.getElementById('hold-shadow');
const root = host.attachShadow({ mode: 'closed' });
root.innerHTML = '<style>${STYLE.replace(/\n/g, "")}</style><button class="hold" id="b">${BUTTON_HTML("Press &amp; Hold")}</button>';
widget(root.getElementById('b'), 'shadow');
document.addEventListener('dragstart', () => fetch('/log/drag', { method: 'POST', body: 'dragstart' }), true);
${VIEW("main")}
</script></body></html>`;
}

/** The frame's page, on the second site. */
export function framePage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>hold frame</title><style>body{margin:8px;font:16px sans-serif}${STYLE}</style></head><body>
<button class="hold" id="hold-frame" aria-label="Press &amp; Hold (frame)">${BUTTON_HTML("Press &amp; Hold")}</button>
<script>${WIDGET}
widget(document.getElementById('hold-frame'), 'frame');
document.addEventListener('dragstart', () => fetch('/log/drag', { method: 'POST', body: 'dragstart' }), true);
${VIEW("frame")}
</script></body></html>`;
}

/** The checks of one widget's log after a hold (the live check's rows). */
export function readHold(l: HoldLog): {
  down: { t: number; x: number; y: number } | null; done: number | null; up: number | null; afterDone: boolean; early: number; drained: boolean;
  allTrusted: boolean; downPressure: number | null; moves: { dx: number; dy: number; t: number; pressure: number | null; buttons: number | null }[]; farthest: number; drags: number; lastMoveBeforeDown: number | null;
} {
  const down = l.states.find((s) => s.s === "down");
  const done = l.states.find((s) => s.s === "done")?.t ?? null;
  const up = l.states.find((s) => s.s === "released-after-done" || s.s === "released-early");
  const pd = l.events.find((e) => e.type === "pointerdown");
  const pu = l.events.find((e) => e.type === "pointerup");
  const moves = !pd ? [] : l.events.filter((e) => e.type === "pointermove" && e.t > pd.t && (!pu || e.t < pu.t)).map((e) => ({ dx: (e.x ?? 0) - (pd.x ?? 0), dy: (e.y ?? 0) - (pd.y ?? 0), t: e.t, pressure: e.pressure, buttons: e.buttons }));
  const before = !pd ? [] : l.events.filter((e) => (e.type === "pointermove" || e.type === "mousemove") && e.t <= pd.t);
  return {
    down: down && typeof down.x === "number" && typeof down.y === "number" ? { t: down.t, x: down.x, y: down.y } : null,
    done, up: up?.t ?? null, afterDone: up?.s === "released-after-done", early: l.states.filter((s) => s.s === "released-early").length, drained: l.states.some((s) => s.s === "drained"),
    allTrusted: l.events.every((e) => e.trusted), downPressure: pd?.pressure ?? null, moves, farthest: Math.max(0, ...moves.map((m) => Math.hypot(m.dx, m.dy))),
    drags: l.events.filter((e) => e.type === "dragstart").length, lastMoveBeforeDown: before.length ? before[before.length - 1].t : null,
  };
}
