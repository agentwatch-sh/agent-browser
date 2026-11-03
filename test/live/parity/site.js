// The probe site's script: what any site can read about the browser, plus the known automation
// traps, reported to the probe server. Plain browser JavaScript, no dependencies. Every value is
// about the browser and the machine; the page holds no secret and reads no other site.
(() => {
  "use strict";
  const P = window.PROBE;
  const T0 = Date.now();
  let queue = [];
  const flush = () => {
    if (!queue.length) return;
    const batch = queue; queue = [];
    fetch(`/page/report?run=${encodeURIComponent(P.run)}`, { method: "POST", body: JSON.stringify(batch), keepalive: true }).catch(() => {});
  };
  const post = (kind, data) => { queue.push({ kind, data, t: Date.now() }); if (queue.length > 20) flush(); };
  setInterval(flush, 200);

  const timeout = (p, ms, label) => Promise.race([p, new Promise((r) => setTimeout(() => r({ timeout: label }), ms))]);
  const safe = async (f) => { try { return await f(); } catch (e) { return { error: `${e && e.name}: ${e && e.message}` }; } };
  const hash = async (s) => {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const names = (o) => { try { return Object.getOwnPropertyNames(o).sort(); } catch { return []; } };

  // --- Traps that run all the time -------------------------------------------------------------

  // The CDP Runtime.enable leak: with a Runtime-enabled inspector session attached, console.debug
  // serializes its argument for the client, and that reads an Error's `stack`. A page sees the read.
  let trapHit = false;
  setInterval(() => {
    const e = new Error("probe");
    let hit = false;
    Object.defineProperty(e, "stack", { configurable: true, get() { hit = true; return ""; } });
    console.debug(e);
    if (hit && !trapHit) { trapHit = true; post("trap", { variant: "error-stack-getter" }); }
    if (!hit && trapHit) { trapHit = false; post("trap-clear", { variant: "error-stack-getter" }); }
  }, 250);

  // The same leak by time: with Runtime enabled, console.debug copies its argument into a protocol
  // message, so a 2 MB string takes measurably longer. One sample a second (the slower of two calls).
  const bigString = "x".repeat(2 * 1024 * 1024);
  setInterval(() => {
    let worst = 0;
    for (let i = 0; i < 2; i++) { const t = performance.now(); console.debug(bigString); worst = Math.max(worst, performance.now() - t); }
    post("console-ms", { ms: Math.round(worst * 100) / 100 });
  }, 1000);

  // Window size: an infobar or a banner shrinks the page.
  const size = () => ({ innerWidth, innerHeight, outerWidth, outerHeight, screenX, screenY });
  let lastSize = JSON.stringify(size());
  setInterval(() => {
    const s = JSON.stringify(size());
    if (s !== lastSize) { lastSize = s; post("resize", size()); }
  }, 100);

  // Timers while the tab is hidden: Chrome throttles them to about 1 s, unless a flag turns that off.
  let ticks = [];
  let hiddenAt = 0;
  setInterval(() => { if (document.visibilityState === "hidden") ticks.push(performance.now()); }, 50);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { hiddenAt = performance.now(); ticks = []; post("visibility", { state: "hidden" }); return; }
    const gaps = ticks.slice(1).map((t, i) => t - ticks[i]).sort((a, b) => a - b);
    post("visibility", {
      state: "visible", hiddenMs: Math.round(performance.now() - hiddenAt), ticks: ticks.length,
      medianGapMs: gaps.length ? Math.round(gaps[gaps.length >> 1]) : null, maxGapMs: gaps.length ? Math.round(gaps[gaps.length - 1]) : null,
    });
  });
  window.addEventListener("focus", () => post("focus", { hasFocus: document.hasFocus() }));
  window.addEventListener("blur", () => post("blur", { hasFocus: document.hasFocus() }));

  // Input events with the fields that bot checks read.
  let moves = 0;
  const mouse = (e) => {
    if (e.type === "mousemove" && ++moves > 50) return;
    post("input", {
      type: e.type, isTrusted: e.isTrusted, target: e.target && e.target.id, clientX: e.clientX, clientY: e.clientY,
      screenX: e.screenX, screenY: e.screenY, pageX: e.pageX, movementX: e.movementX, movementY: e.movementY,
      offsetX: e.offsetX, button: e.button, buttons: e.buttons, detail: e.detail,
      pointerType: e.pointerType, pressure: e.pressure, width: e.width, height: e.height, pointerId: e.pointerId,
      tiltX: e.tiltX, isPrimary: e.isPrimary, timeStamp: Math.round(e.timeStamp),
      window: { screenX: window.screenX, screenY: window.screenY, outerHeight, innerHeight, outerWidth, innerWidth },
    });
  };
  for (const t of ["mousemove", "mousedown", "mouseup", "click", "pointerdown", "pointerup", "pointermove"]) document.addEventListener(t, mouse, true);
  const key = (e) => post("input", {
    type: e.type, isTrusted: e.isTrusted, key: e.key, code: e.code, keyCode: e.keyCode, which: e.which, charCode: e.charCode,
    repeat: e.repeat, location: e.location, inputType: e.inputType, timeStamp: Math.round(e.timeStamp),
  });
  for (const t of ["keydown", "keypress", "keyup", "beforeinput", "input"]) document.addEventListener(t, key, true);
  setInterval(() => post("tick", { webdriver: navigator.webdriver, hasFocus: document.hasFocus(), visibility: document.visibilityState }), 5000);

  // --- The fingerprint, once, at load ----------------------------------------------------------

  const FONTS = ["Arial", "Helvetica", "Helvetica Neue", "Times New Roman", "Times", "Courier New", "Courier", "Verdana", "Georgia",
    "Palatino", "Comic Sans MS", "Trebuchet MS", "Arial Black", "Impact", "Tahoma", "Segoe UI", "Calibri", "Cambria", "Consolas",
    "Menlo", "Monaco", "SF Pro", "SF Pro Text", "SF Mono", "Apple Color Emoji", "Apple SD Gothic Neo", "Hiragino Sans", "PingFang SC",
    "Avenir", "Avenir Next", "Futura", "Gill Sans", "Optima", "Lucida Grande", "Geneva", "Noto Sans", "Noto Serif", "Noto Color Emoji",
    "DejaVu Sans", "DejaVu Serif", "DejaVu Sans Mono", "Liberation Sans", "Liberation Serif", "Liberation Mono", "Ubuntu", "Cantarell",
    "Roboto", "Open Sans", "Droid Sans", "FreeSans", "Nimbus Sans", "Source Code Pro", "Fira Sans", "Segoe UI Emoji", "MS Gothic",
    "Microsoft YaHei", "Symbol", "Wingdings", "Zapfino", "Marker Felt", "Chalkboard", "Papyrus", "Baskerville", "Didot", "Rockwell"];

  function fonts() {
    const c = document.createElement("canvas").getContext("2d");
    const text = "mmmmmmmmmmlli1WQ@#";
    const base = {};
    for (const g of ["monospace", "sans-serif", "serif"]) { c.font = `72px ${g}`; base[g] = c.measureText(text).width; }
    return FONTS.filter((f) => ["monospace", "sans-serif", "serif"].some((g) => { c.font = `72px "${f}", ${g}`; return c.measureText(text).width !== base[g]; }));
  }

  async function canvas2d() {
    const cv = document.createElement("canvas"); cv.width = 300; cv.height = 80;
    const c = cv.getContext("2d");
    c.textBaseline = "top"; c.font = "16px Arial"; c.fillStyle = "#f60"; c.fillRect(100, 1, 62, 20);
    c.fillStyle = "#069"; c.fillText("parity probe \u{1F600} éß", 2, 15);
    c.fillStyle = "rgba(102,204,0,0.7)"; c.font = "18px serif"; c.fillText("parity probe", 4, 45);
    c.beginPath(); c.arc(250, 40, 30, 0, Math.PI * 2); c.stroke();
    return hash(cv.toDataURL());
  }

  async function webgl(kind) {
    const cv = document.createElement("canvas");
    const gl = cv.getContext(kind);
    if (!gl) return null;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const P = ["MAX_TEXTURE_SIZE", "MAX_RENDERBUFFER_SIZE", "MAX_VIEWPORT_DIMS", "MAX_VERTEX_ATTRIBS", "MAX_VERTEX_UNIFORM_VECTORS",
      "MAX_FRAGMENT_UNIFORM_VECTORS", "MAX_VARYING_VECTORS", "MAX_COMBINED_TEXTURE_IMAGE_UNITS", "ALIASED_LINE_WIDTH_RANGE",
      "ALIASED_POINT_SIZE_RANGE", "SHADING_LANGUAGE_VERSION", "VERSION", "MAX_SAMPLES"];
    const params = {};
    for (const p of P) { const v = gl[p] === undefined ? undefined : gl.getParameter(gl[p]); if (v !== undefined && v !== null) params[p] = v && v.length !== undefined && typeof v !== "string" ? [...v] : v; }
    return {
      vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null, unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      extensions: (gl.getSupportedExtensions() || []).sort(), params,
    };
  }

  async function audio() {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const osc = ctx.createOscillator(); osc.type = "triangle"; osc.frequency.value = 10000;
    const comp = ctx.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    let s = 0; for (let i = 4500; i < 5000; i++) s += Math.abs(d[i]);
    return { sum: s, sampleRate: new AudioContext().sampleRate };
  }

  async function webgpu() {
    if (!navigator.gpu) return { available: false };
    const a = await timeout(navigator.gpu.requestAdapter(), 3000, "requestAdapter");
    if (!a || a.timeout) return { available: true, adapter: a || null };
    const info = a.info || {};
    return { available: true, info: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description }, features: [...a.features].sort() };
  }

  async function media() {
    const v = document.createElement("video");
    const types = ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/webm; codecs="vp9"', 'video/mp4; codecs="av01.0.05M.08"',
      'audio/mp4; codecs="mp4a.40.2"', 'audio/ogg; codecs="opus"', 'audio/mpeg', 'audio/flac', 'video/ogg; codecs="theora"'];
    const canPlay = Object.fromEntries(types.map((t) => [t, v.canPlayType(t)]));
    const mse = Object.fromEntries(types.map((t) => [t, typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(t)]));
    const eme = {};
    for (const ks of ["com.widevine.alpha", "org.w3.clearkey"]) {
      eme[ks] = await safe(async () => {
        const r = await timeout(navigator.requestMediaKeySystemAccess(ks, [{ initDataTypes: ["cenc"], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }]), 4000, "eme");
        return r && r.timeout ? r : { ok: true, keySystem: r.keySystem };
      });
    }
    const devices = await safe(async () => {
      const l = await navigator.mediaDevices.enumerateDevices();
      return l.reduce((m, d) => ((m[d.kind] = (m[d.kind] || 0) + 1), m), {});
    });
    return { canPlay, mse, eme, devices };
  }

  async function permissions() {
    const out = { notificationPermission: typeof Notification !== "undefined" ? Notification.permission : null };
    for (const name of ["notifications", "geolocation", "camera", "microphone", "clipboard-read", "midi", "persistent-storage", "local-fonts", "window-management"]) {
      out[name] = await safe(async () => (await navigator.permissions.query({ name })).state);
    }
    return out;
  }

  async function voices() {
    let v = speechSynthesis.getVoices();
    if (!v.length) await timeout(new Promise((r) => speechSynthesis.addEventListener("voiceschanged", r, { once: true })), 2000, "voices");
    v = speechSynthesis.getVoices();
    return { count: v.length, names: v.slice(0, 15).map((x) => `${x.name}|${x.lang}|${x.localService}`) };
  }

  async function fingerprint() {
    const nav = navigator;
    const uad = nav.userAgentData;
    const out = {
      navigator: {
        userAgent: nav.userAgent, appVersion: nav.appVersion, platform: nav.platform, vendor: nav.vendor, productSub: nav.productSub,
        language: nav.language, languages: [...nav.languages], hardwareConcurrency: nav.hardwareConcurrency, deviceMemory: nav.deviceMemory,
        maxTouchPoints: nav.maxTouchPoints, webdriver: nav.webdriver, webdriverInNavigator: "webdriver" in nav,
        pdfViewerEnabled: nav.pdfViewerEnabled, cookieEnabled: nav.cookieEnabled, doNotTrack: nav.doNotTrack, onLine: nav.onLine,
        plugins: [...nav.plugins].map((p) => p.name), mimeTypes: [...nav.mimeTypes].map((m) => m.type),
        connection: nav.connection ? { effectiveType: nav.connection.effectiveType, rtt: nav.connection.rtt, downlink: nav.connection.downlink, saveData: nav.connection.saveData } : null,
        globalPrivacyControl: nav.globalPrivacyControl,
      },
      userAgentData: uad ? {
        brands: uad.brands, mobile: uad.mobile, platform: uad.platform,
        high: await safe(() => uad.getHighEntropyValues(["architecture", "bitness", "brands", "formFactors", "fullVersionList", "model", "platformVersion", "uaFullVersion", "wow64"])),
      } : null,
      chromeObject: typeof window.chrome === "object" ? {
        keys: Object.keys(window.chrome).sort(), runtime: typeof window.chrome.runtime, app: window.chrome.app ? Object.keys(window.chrome.app).sort() : null,
        csi: typeof window.chrome.csi, loadTimes: typeof window.chrome.loadTimes,
      } : null,
      screen: {
        width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, availLeft: screen.availLeft,
        availTop: screen.availTop, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth, devicePixelRatio, orientation: screen.orientation && screen.orientation.type,
        isExtended: screen.isExtended,
      },
      window: size(),
      media_queries: Object.fromEntries(["(prefers-color-scheme: dark)", "(prefers-reduced-motion: reduce)", "(pointer: fine)", "(hover: hover)", "(any-pointer: coarse)",
        "(color-gamut: p3)", "(dynamic-range: high)", "(forced-colors: active)", "(prefers-contrast: more)", "(display-mode: browser)"].map((q) => [q, matchMedia(q).matches])),
      intl: { ...Intl.DateTimeFormat().resolvedOptions(), offset: new Date().getTimezoneOffset(), number: new Intl.NumberFormat().format(1234567.891), date0: new Date(0).toString() },
      fonts: fonts(),
      canvas: await safe(canvas2d),
      webgl: await safe(() => webgl("webgl")),
      webgl2: await safe(() => webgl("webgl2")),
      webgpu: await safe(webgpu),
      audio: await safe(audio),
      media: await safe(media),
      permissions: await safe(permissions),
      voices: await safe(voices),
      storage: await safe(async () => { const e = await navigator.storage.estimate(); return { quota: e.quota }; }),
      memory: performance.memory ? { jsHeapSizeLimit: performance.memory.jsHeapSizeLimit } : null,
      navigation: (() => { const n = performance.getEntriesByType("navigation")[0]; return n ? { nextHopProtocol: n.nextHopProtocol, type: n.type } : null; })(),
      secureContext: isSecureContext,
      focus: { hasFocus: document.hasFocus(), visibility: document.visibilityState },
      // What exists: diffing these lists between two browsers names the features of one version only.
      globals: names(window).filter((n) => n !== "PROBE"),
      prototypes: {
        Navigator: names(Navigator.prototype), Document: names(Document.prototype), Element: names(Element.prototype),
        HTMLElement: names(HTMLElement.prototype), Window: names(Window.prototype),
      },
      cssProperties: [...getComputedStyle(document.documentElement)].sort(),
    };
    out.hashes = {
      globals: await hash(out.globals.join(",")), cssProperties: await hash(out.cssProperties.join(",")),
      prototypes: await hash(JSON.stringify(out.prototypes)), webglExtensions: await hash(JSON.stringify(out.webgl && out.webgl.extensions)),
    };
    return out;
  }

  // An extension that a page can see: a web-accessible resource or a message to its ID.
  async function extensionVisible() {
    const r = await fetch("/page/extid").then((x) => x.json()).catch(() => ({}));
    if (!r.id) return { id: null };
    const res = { id: r.id };
    res.manifestFetch = await safe(async () => { const x = await fetch(`chrome-extension://${r.id}/manifest.json`); return { status: x.status }; });
    res.runtimeOnPage = typeof (window.chrome && window.chrome.runtime && window.chrome.runtime.sendMessage);
    return res;
  }

  window.addEventListener("load", async () => {
    const t = Date.now();
    const fp = await fingerprint();
    post("fp", { ...fp, collectMs: Date.now() - t, sinceStartMs: Date.now() - T0 });
    const r = document.getElementById("target").getBoundingClientRect();
    post("target", { x: r.x, y: r.y, width: r.width, height: r.height, window: size(), devicePixelRatio });
    setTimeout(async () => post("extension-visible", await extensionVisible()), 2500);
    flush();
  });
})();
