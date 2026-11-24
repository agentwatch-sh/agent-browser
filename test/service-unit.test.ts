// The Chrome unit of `agent-browser service` (the self-contained design, sections 5.1, 5.2 and 13.2; board
// ab-v16.94.3): Xvfb with its auth file and its display, Chrome detached with its flags and its environment, the unit
// record, the adoption by pid and start time, the boot sweep, the stop, the supervisor and the Google Chrome install of
// a start. The unit's real code runs against a fake world (test/fake-unit-world.ts): a fake /proc, a fake X root, fake
// processes and a virtual clock. One test starts a real `sleep` to check the detached spawn and the group signal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AGENT_ARGS } from "../src/agent.ts";
import { abstractDisplays, DISPLAY_FIRST, DISPLAY_LAST, displayInUse, freeDisplays, realDisplayFs } from "../src/service/unit/display.ts";
import { Procs } from "../src/service/unit/procs.ts";
import { readRecord, writeJsonDurable } from "../src/service/unit/record.ts";
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, HEALTHY_MS, SUPERVISE_MS, CHROME_INSTALLING, CHROME_NOT_INSTALLED, ChromeUnit, configFrom, ConfigError, DEFAULT_CONFIG, KIND_CHROMIUM, KIND_GOOGLE, NotOwnerError, signalGroup, spawnDetached, StartError, STOPPED_DURING_INSTALL, XVFB_TRIES, type UnitEvent } from "../src/service/unit/unit.ts";
import { AUTH_NAME, COOKIE_LEN, writeXauthority, xauthEntry } from "../src/service/unit/xauth.ts";
import { FakeTools, World } from "./fake-unit-world.ts";
import { RECEIVER_ID } from "../src/service/package/pins.ts";
import { accessKey, accessLine, accessNote, isOff, offKey, offLine, receiverAccess, receiverOff, type ReceiverOff } from "../src/service/unit/access.ts";

const CHROMIUM = { ...DEFAULT_CONFIG, chromeBin: "/usr/bin/chromium" };
function unitIn(w: World, o: { tools?: FakeTools; cfg?: typeof DEFAULT_CONFIG | null; displays?: { first: number; last: number }; mayAct?: (what: string) => Promise<boolean> } = {}) {
  const tools = o.tools ?? new FakeTools();
  const u = new ChromeUnit(w.deps(tools, { displays: o.displays ?? { first: 173, last: 175 }, mayAct: o.mayAct }));
  u.config = o.cfg === undefined ? CHROMIUM : o.cfg;
  return { u, tools };
}
const record = (w: World) => { const r = readRecord(w.paths.unitFile); assert.equal(r.kind, "ok"); return (r as any).record; };
const chromeOf = (w: World) => w.spawned.filter((p) => !p.argv[0].endsWith("Xvfb"));
const xvfbOf = (w: World) => w.spawned.filter((p) => p.argv[0].endsWith("Xvfb"));

// ------------------------------------------------------------------ Xvfb, its display and its auth file

test("Xvfb: -nolisten tcp, its own auth file, the screen of browser.display_size, on the first free display; its record names it", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w, { cfg: { ...CHROMIUM, displaySize: "1440x960" } });
    assert.equal(await u.start(), true);
    const [x] = xvfbOf(w);
    assert.deepEqual(x.argv, ["/usr/bin/Xvfb", ":173", "-nolisten", "tcp", "-auth", w.paths.xauth, "-screen", "0", "1440x960x24"]);
    assert.equal(statSync(w.paths.xauth).mode & 0o777, 0o600);
    const r = record(w);
    assert.equal(r.display, 173);
    assert.equal(r.xvfb_pid, x.pid);
    assert.equal(r.xvfb_start, x.start);
    assert.deepEqual(r.display_size, [1440, 960]);
  } finally { w.close(); }
});

test("the X auth file: one FamilyWild MIT-MAGIC-COOKIE-1 entry (the bytes of a hand-built vector), mode 0600 also over a looser file; a fresh cookie at each Xvfb start; no argv, environment value or log line holds the cookie", async () => {
  const w = new World();
  try {
    const cookie = Buffer.from("0123456789abcdef");
    const want = Buffer.concat([Buffer.from([0xff, 0xff, 0, 0, 0, 3]), Buffer.from("173"), Buffer.from([0, 18]), Buffer.from(AUTH_NAME), Buffer.from([0, 16]), cookie]);
    assert.deepEqual(xauthEntry(173, cookie), want);
    const loose = join(w.dir, "loose");
    writeFileSync(loose, "x", { mode: 0o644 });
    writeXauthority(loose, 173, cookie);
    assert.equal(statSync(loose).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(loose), want);
    assert.throws(() => xauthEntry(1, Buffer.from("short")), (e: Error) => !e.message.includes("short") && e.message.includes(String(COOKIE_LEN)));
    const { u } = unitIn(w);
    await u.start();
    const first = readFileSync(w.paths.xauth).subarray(-16);
    await u.stop();
    await u.start();
    const second = readFileSync(w.paths.xauth).subarray(-16);
    assert.notDeepEqual(first, second, "a fresh cookie at each start");
    const hex = [first, second].map((b) => b.toString("hex"));
    for (const p of w.spawned) {
      for (const a of [...p.argv, ...Object.values(p.env ?? {})]) for (const h of hex) assert.ok(!a.includes(h) && !a.includes(Buffer.from(h, "hex").toString("latin1")), "no argv or env value holds the cookie");
    }
    for (const l of w.logs) for (const h of hex) assert.ok(!l.includes(h));
  } finally { w.close(); }
});

test("the display chooser: the first free display from 90 to 189; a display in use (its socket, its lock file, or its abstract socket) is skipped", () => {
  assert.deepEqual([DISPLAY_FIRST, DISPLAY_LAST], [90, 189]);
  const exists = new Set(["/x/.X11-unix/X90", "/x/.X91-lock"]);
  const net = "Num       RefCount Protocol Flags    Type St Inode Path\n0000000000000000: 00000002 00000000 00010000 0001 01 1 @/tmp/.X11-unix/X92\n0000000000000000: 00000002 00000000 00010000 0001 01 2 /tmp/.X11-unix/X95\n";
  const fs = { exists: (p: string) => exists.has(p), netUnix: () => net };
  assert.deepEqual([...abstractDisplays(net)], [92]);
  assert.equal(displayInUse(90, "/x", fs), true, "its socket");
  assert.equal(displayInUse(91, "/x", fs), true, "its lock file");
  assert.equal(displayInUse(92, "/x", fs), true, "its abstract socket");
  assert.equal(displayInUse(93, "/x", fs), false);
  assert.deepEqual(freeDisplays("/x", fs).slice(0, 2), [93, 94]);
  assert.equal(freeDisplays("/x", fs).at(-1), 189);
  assert.equal(freeDisplays("/x", fs).length, 100 - 3);
});

test("a start skips a taken display, moves to the next display when Xvfb exits, fails after 10 exits, and stops an Xvfb that opens no display in 5 s", async () => {
  const w = new World();
  try {
    writeFileSync(join(w.xRoot, ".X173-lock"), "");
    const { u } = unitIn(w);
    w.behave.Xvfb = ["exit"];
    await u.start();
    assert.deepEqual(xvfbOf(w).map((p) => p.argv[1]), [":174", ":175"], "173 taken, 174 exited, 175 took");
    await u.stop();
    const w2 = new World();
    try {
      const { u: u2 } = unitIn(w2, { displays: { first: 100, last: 130 } });
      w2.behave.Xvfb = Array(XVFB_TRIES).fill("exit");
      await assert.rejects(u2.start(), (e: Error) => e instanceof StartError && e.message === `Xvfb exited on ${XVFB_TRIES} displays in a row`);
      w2.behave.Xvfb = ["nosocket"];
      await assert.rejects(u2.start(), /Xvfb did not open display :100 in 5 s/);
      assert.equal(w2.alive(xvfbOf(w2).at(-1)!.pid), false, "the Xvfb with no display is stopped");
    } finally { w2.close(); }
  } finally { w.close(); }
});

// ------------------------------------------------------------------ Chrome, its flags and its environment

test("Chrome: detached on the unit's display, on the agent profile, with AGENT_ARGS, the fixed flags, the config's lang, size and chrome_args, and about:blank; chrome_bin from config keeps the way back to Chromium", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w, { cfg: { ...CHROMIUM, chromeArgs: ["--enable-features=Foo"], lang: "de-DE", displaySize: "1280x900" } });
    await u.start();
    const [c] = chromeOf(w);
    assert.deepEqual(c.argv, ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`, ...AGENT_ARGS, "--password-store=basic",
      "--silent-debugger-extension-api", "--enable-unsafe-swiftshader", "--lang=de-DE", "--window-position=0,0", "--window-size=1280,900", "--enable-features=Foo", "about:blank"]);
    assert.equal(c.argv.some((a) => /remote-debugging|enable-automation|headless/.test(a)), false);
    assert.deepEqual(u.chromeFacts(), { kind: KIND_CHROMIUM, version: "" });
    const r = record(w);
    assert.equal(r.wanted, true);
    assert.equal(r.chrome_pid, c.pid);
    assert.equal(r.chrome_start, c.start);
    assert.deepEqual(r.chrome, { kind: KIND_CHROMIUM, version: "" });
    assert.equal(r.chrome_bin, "/usr/bin/chromium");
    assert.equal(typeof r.started_at, "number");
  } finally { w.close(); }
});

test("assertSafeChromeArgs is the only flags check: a refused switch in chrome_args (remote debugging, automation, headless, another profile) refuses the start before any spawn, and names the switch, never its value", async () => {
  for (const bad of ["--remote-debugging-port=9222", "-remote-debugging-pipe", "--enable-automation", " --headless=new", "--user-data-dir=/srv/ann/.config/google-chrome", "--profile-directory=Default"]) {
    const w = new World();
    try {
      const { u } = unitIn(w, { cfg: { ...CHROMIUM, chromeArgs: ["--ok", bad] } });
      await assert.rejects(u.start(), (e: Error) => e instanceof ConfigError && /refusing to launch Chrome with --/.test(e.message) && !e.message.includes("9222") && !e.message.includes("google-chrome"), bad);
      assert.equal(w.spawned.length, 0, `${bad}: nothing started`);
    } finally { w.close(); }
  }
});

test("Chrome's environment is built from scratch: only PATH, HOME (the unit's own), LANG, XDG_RUNTIME_DIR, DISPLAY, XAUTHORITY, TZ when set, and CHROME_VERSION_EXTRA for Google Chrome; no token", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w, { cfg: { ...CHROMIUM, timezone: "Europe/Berlin" } });
    await u.start();
    const [c] = chromeOf(w);
    assert.deepEqual(c.env, { PATH: "/usr/bin:/bin", HOME: w.paths.home, LANG: "C.UTF-8", XDG_RUNTIME_DIR: "/run/user/1000", DISPLAY: ":173", XAUTHORITY: w.paths.xauth, TZ: "Europe/Berlin" });
    assert.deepEqual(xvfbOf(w)[0].env, { PATH: "/usr/bin:/bin", HOME: w.deps(new FakeTools()).env!.HOME, LANG: "C.UTF-8", XDG_RUNTIME_DIR: "/run/user/1000" }, "Xvfb keeps the service's HOME");
    assert.equal(statSync(w.paths.downloads).mode & 0o777, 0o700);
    const prefs = JSON.parse(readFileSync(w.paths.preferences, "utf8"));
    assert.equal(prefs.download.default_directory, w.paths.downloads);
  } finally { w.close(); }
});

test("Chrome's preferences before each start (the stored sign-ins, C11): no password saving, no leak check, no autofill, and the receiver allowed in incognito; the other keys stay", async () => {
  const w = new World();
  try {
    mkdirSync(join(w.paths.profile, "Default"), { recursive: true });
    writeFileSync(w.paths.preferences, JSON.stringify({ profile: { name: "Person 1" }, extensions: { settings: { [RECEIVER_ID]: { location: 1 }, otherextension: { incognito: false } } }, autofill: { enabled: true } }));
    const { u } = unitIn(w, { cfg: CHROMIUM });
    await u.start();
    const check = () => {
      const p = JSON.parse(readFileSync(w.paths.preferences, "utf8"));
      assert.equal(p.credentials_enable_service, false);
      assert.deepEqual(p.profile, { name: "Person 1", password_manager_enabled: false, password_manager_leak_detection: false });
      assert.deepEqual(p.autofill, { enabled: false, profile_enabled: false, credit_card_enabled: false });
      assert.deepEqual(p.extensions.settings[RECEIVER_ID], { location: 1, incognito: true, newAllowFileAccess: true });
      assert.deepEqual(p.extensions.settings.otherextension, { incognito: false }, "another extension's settings stay");
      assert.equal(p.download.default_directory, w.paths.downloads);
    };
    check();
    // Chrome drops a key (round 1: autofill.enabled): the next start writes it again.
    const p = JSON.parse(readFileSync(w.paths.preferences, "utf8"));
    delete p.autofill.enabled; delete p.extensions.settings[RECEIVER_ID].incognito; delete p.extensions.settings[RECEIVER_ID].newAllowFileAccess;
    writeFileSync(w.paths.preferences, JSON.stringify(p));
    await u.stop();
    await u.start();
    check();
  } finally { w.close(); }
});

test("board ab-t30.27: before each start the receiver gets access to local files (extensions.settings.<receiver ID>.newAllowFileAccess true in the profile's Preferences, Chrome's \"Allow access to file URLs\"), also over a false; another extension gets none; the write replaces the file whole; a Preferences that is not a JSON object stays as it is", async () => {
  const w = new World();
  try {
    // A new profile: no Preferences yet.
    const { u } = unitIn(w, { cfg: CHROMIUM });
    await u.start();
    const read = () => JSON.parse(readFileSync(w.paths.preferences, "utf8"));
    assert.equal(read().extensions.settings[RECEIVER_ID].newAllowFileAccess, true, "a new profile");
    assert.equal(statSync(w.paths.preferences).mode & 0o777, 0o600);
    await u.stop();
    // A false (the switch turned off in chrome://extensions, or Chrome's own default for a packed extension) and another
    // extension's own value: the receiver's goes true again at the next start, the other one's stays.
    const p = read();
    p.extensions.settings[RECEIVER_ID] = { ...p.extensions.settings[RECEIVER_ID], newAllowFileAccess: false, path: "ifhf/0.3.8_0", state: 1 };
    p.extensions.settings.otherextension = { newAllowFileAccess: false };
    p.extensions.settings.thirdextension = { path: "x/1.0_0" };
    writeFileSync(w.paths.preferences, JSON.stringify(p));
    const ino = statSync(w.paths.preferences).ino;
    await u.start();
    const q = read();
    assert.deepEqual(q.extensions.settings[RECEIVER_ID], { incognito: true, newAllowFileAccess: true, path: "ifhf/0.3.8_0", state: 1 });
    assert.deepEqual(q.extensions.settings.otherextension, { newAllowFileAccess: false });
    assert.deepEqual(q.extensions.settings.thirdextension, { path: "x/1.0_0" }, "no access for another extension");
    assert.notEqual(statSync(w.paths.preferences).ino, ino, "a new file renamed over the old one (no write into the file that Chrome reads)");
    await u.stop();
    // A file that is not a JSON object: the start leaves it as it is, and says so.
    for (const bad of ["{not json", "[1,2]"]) {
      writeFileSync(w.paths.preferences, bad);
      // Only this start's own lines (review-153 N10): the line of the earlier case does not count.
      const from = w.logs.length;
      await u.start();
      assert.equal(readFileSync(w.paths.preferences, "utf8"), bad);
      const mine = w.logs.slice(from).filter((l) => l.includes("the Preferences file is not a JSON object") && l.includes("the receiver has no access to local files"));
      assert.equal(mine.length, 1, `${bad}: ${w.logs.slice(from).join("\n")}`);
      await u.stop();
    }
  } finally { w.close(); }
});

test("board ab-v16.94.31: receiverAccess reads the receiver's incognito and file keys of a running Chrome's profile (Secure Preferences when it holds the receiver's entry, else Preferences) and writes nothing; a file that cannot be read or is not a JSON object is unknown, not missing", () => {
  const w = new World();
  try {
    const dir = join(w.paths.profile, "Default");
    mkdirSync(dir, { recursive: true });
    const secure = join(dir, "Secure Preferences");
    const put = (p: string, v: unknown) => writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
    const entry = (e: unknown) => ({ profile: { name: "Person 1" }, extensions: { settings: { [RECEIVER_ID]: e, otherextension: { incognito: true, newAllowFileAccess: true } } } });
    const read = () => receiverAccess(w.paths.preferences);
    assert.deepEqual(read(), { state: "unknown", why: "no Preferences file" }, "no file: unknown");
    put(w.paths.preferences, entry({ location: 1 }));
    assert.deepEqual(read(), { state: "missing", missing: ["incognito", "file"], gives: "service" }, "neither key (the case of the release)");
    put(w.paths.preferences, entry({ location: 1, incognito: true, newAllowFileAccess: false }));
    assert.deepEqual(read(), { state: "missing", missing: ["file"], gives: "service" });
    put(w.paths.preferences, entry({ location: 1, incognito: "true", newAllowFileAccess: true }));
    assert.deepEqual(read(), { state: "missing", missing: ["incognito"], gives: "service" }, "only true counts");
    put(w.paths.preferences, { extensions: { settings: { otherextension: { incognito: true, newAllowFileAccess: true } } } });
    assert.deepEqual(read(), { state: "missing", missing: ["incognito", "file"], gives: "service" }, "no entry of the receiver: another extension's keys do not count");
    put(w.paths.preferences, entry({ location: 1, incognito: true, newAllowFileAccess: true }));
    assert.deepEqual(read(), { state: "ok" });
    // Secure Preferences: its entry of the receiver comes first; with no entry there, Preferences decides.
    put(secure, entry({ location: 1, incognito: false, newAllowFileAccess: true }));
    assert.deepEqual(read(), { state: "missing", missing: ["incognito"], gives: "operator" }, "Secure Preferences' entry first");
    put(secure, { protection: { macs: {} } });
    assert.deepEqual(read(), { state: "ok" }, "Secure Preferences with no entry of the receiver");
    // A file that cannot be read or is not a JSON object: unknown, never missing.
    for (const [file, bad, why] of [[w.paths.preferences, "{not json", "Preferences is not a JSON object"], [w.paths.preferences, "[1,2]", "Preferences is not a JSON object"], [secure, "{\"extensions\":", "Secure Preferences is not a JSON object"]] as const) {
      const keep = readFileSync(file, "utf8");
      put(file, bad);
      assert.deepEqual(read(), { state: "unknown", why }, bad);
      put(file, keep);
    }
    rmSync(secure);
    mkdirSync(secure); // a folder in place of the file: the read fails (EISDIR)
    assert.deepEqual(read(), { state: "unknown", why: "Secure Preferences cannot be read (EISDIR)" });
    rmSync(secure, { recursive: true });
    // The read writes nothing: the file's bytes and its inode stay.
    const before = readFileSync(w.paths.preferences, "utf8"), ino = statSync(w.paths.preferences).ino;
    read();
    assert.equal(readFileSync(w.paths.preferences, "utf8"), before);
    assert.equal(statSync(w.paths.preferences).ino, ino);
  } finally { w.close(); }
});

test("board ab-v16.94.34: who gives a missing access: the operator gives the incognito access when Secure Preferences holds the receiver's entry (the Mac's sitting) or, on the Mac, when no file holds it; the service gives it when Preferences holds the entry (Linux, the packed CRX); the access to local files always gets the service's sentence (the daemon lead's correction: Chrome gives an unpacked extension that access by itself); Linux's sentence and line stay", () => {
  const w = new World();
  try {
    const dir = join(w.paths.profile, "Default");
    mkdirSync(dir, { recursive: true });
    const secure = join(dir, "Secure Preferences");
    const put = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v));
    const entry = (e: unknown) => ({ extensions: { settings: { [RECEIVER_ID]: e } } });
    const read = (mac?: boolean) => (mac === undefined ? receiverAccess(w.paths.preferences) : receiverAccess(w.paths.preferences, { mac }));
    // Preferences holds the entry: the service gives it, on Linux and on the Mac.
    put(w.paths.preferences, entry({ location: 1 }));
    assert.deepEqual(read(), { state: "missing", missing: ["incognito", "file"], gives: "service" });
    assert.deepEqual(read(true), { state: "missing", missing: ["incognito", "file"], gives: "service" }, "the entry's file decides");
    // No file holds the entry: the service's write gives it on Linux; on the Mac Chrome drops that write.
    put(w.paths.preferences, { profile: { name: "Person 1" } });
    assert.deepEqual(read(), { state: "missing", missing: ["incognito", "file"], gives: "service" });
    assert.deepEqual(read(false), { state: "missing", missing: ["incognito", "file"], gives: "service" });
    assert.deepEqual(read(true), { state: "missing", missing: ["incognito", "file"], gives: "operator" });
    // The sitting's files: Secure Preferences holds the entry (location 4: unpacked), Preferences holds none.
    put(secure, entry({ location: 4, newAllowFileAccess: true }));
    assert.deepEqual(read(), { state: "missing", missing: ["incognito"], gives: "operator" });
    assert.deepEqual(read(true), { state: "missing", missing: ["incognito"], gives: "operator" });
    // Only the access to local files is missing on the Mac: the service's sentence, as on Linux.
    put(secure, entry({ location: 4, incognito: true }));
    assert.deepEqual(read(), { state: "missing", missing: ["file"], gives: "service" });
    assert.deepEqual(read(true), { state: "missing", missing: ["file"], gives: "service" });
    put(secure, entry({ location: 4, incognito: true, newAllowFileAccess: true }));
    assert.deepEqual(read(), { state: "ok" });
    // The sentences: the operator's switch names only 'Allow in Incognito'; the access to local files gets the service's step.
    const needs = "in the agent Chrome (PageFetch and the sign-in act need incognito access; a file input needs access to local files).";
    const incognitoStep = "In the agent Chrome, open chrome://extensions, click Details of the agent extension and turn on 'Allow in Incognito'.";
    const linux = "The service's next start of the agent Chrome gives this access: a stop and a start of the agent browser give it now.";
    assert.equal(accessNote({ state: "missing", missing: ["incognito"], gives: "operator" }), `The agent extension lacks incognito access ${needs} ${incognitoStep}`);
    assert.equal(accessNote({ state: "missing", missing: ["incognito", "file"], gives: "operator" }), `The agent extension lacks incognito access and access to local files ${needs} ${incognitoStep} The service's next start of the agent Chrome gives the access to local files: a stop and a start of the agent browser give it now.`);
    for (const n of [accessNote({ state: "missing", missing: ["file"], gives: "service" })!, accessNote({ state: "missing", missing: ["incognito", "file"], gives: "operator" })!]) assert.ok(!n.includes("Allow access to file URLs"), n);
    // Linux's sentence and line stay word for word; a Mac with only the access to local files missing gets them too.
    assert.equal(accessNote({ state: "missing", missing: ["incognito", "file"], gives: "service" }), `The agent extension lacks incognito access and access to local files ${needs} ${linux}`);
    assert.equal(accessNote({ state: "missing", missing: ["file"], gives: "service" }), `The agent extension lacks access to local files ${needs} ${linux}`);
    assert.equal(accessNote({ state: "missing", missing: ["file"], gives: "service" }, { mac: false }), `The agent extension lacks access to local files ${needs} ${linux}`, "mac false: Linux's sentence");
    // Board ab-v16.105 (the daemon lead's note of 2026-11-20): on the Mac neither PageFetch nor the sign-in act runs yet, so
    // the Mac's sentence says that they need the incognito access when they come to the Mac. The steps stay as they are.
    const macNeeds = "in the agent Chrome (PageFetch and the sign-in act need incognito access when they come to the Mac; a file input needs access to local files).";
    assert.equal(accessNote({ state: "missing", missing: ["incognito"], gives: "operator" }, { mac: true }), `The agent extension lacks incognito access ${macNeeds} ${incognitoStep}`);
    assert.equal(accessNote({ state: "missing", missing: ["incognito", "file"], gives: "operator" }, { mac: true }), `The agent extension lacks incognito access and access to local files ${macNeeds} ${incognitoStep} The service's next start of the agent Chrome gives the access to local files: a stop and a start of the agent browser give it now.`);
    assert.equal(accessNote({ state: "missing", missing: ["file"], gives: "service" }, { mac: true }), `The agent extension lacks access to local files ${macNeeds} ${linux}`);
    assert.equal(accessNote({ state: "unknown", why: "x" }, { mac: true }), accessNote({ state: "unknown", why: "x" }), "the unknown sentence is the same on both systems");
    assert.equal(accessNote({ state: "ok" }, { mac: true }), null);
    assert.equal(accessLine("link-up", { state: "missing", missing: ["file"], gives: "service" }, "/srv/state/profile", 7), `unit: at the link-up the receiver lacks access to local files in the profile "profile" (Chrome pid 7); the service's next Chrome start gives it`);
    assert.equal(accessLine("re-read", { state: "missing", missing: ["incognito"], gives: "operator" }, "/srv/state/profile", 7), `unit: at the re-read the receiver lacks incognito access in the profile "profile" (Chrome pid 7); only the operator's switch in chrome://extensions gives it`);
    assert.equal(accessLine("adoption", { state: "missing", missing: ["incognito", "file"], gives: "operator" }, "/srv/state/profile", 7), `unit: at the adoption the receiver lacks incognito access and access to local files in the profile "profile" (Chrome pid 7); only the operator's switch in chrome://extensions gives the incognito access, and the service's next Chrome start gives the access to local files`);
    // A change of the giver is a new result (a new line).
    assert.notEqual(accessKey({ state: "missing", missing: ["incognito"], gives: "service" }), accessKey({ state: "missing", missing: ["incognito"], gives: "operator" }));
  } finally { w.close(); }
});

// Board ab-v16.116: the Mac's Chrome 158 after 157 kept the receiver's entry in Secure Preferences as a stub
// (disable_reasons [16777216], that is 1 << 24: an unpacked extension while developer mode is off; no path, location,
// state or manifest). The values here are the stub's shape, in temp files only.
const STUB = { content_settings: [], disable_reasons: [16777216] };
test("board ab-v16.116: receiverOff reads the receiver's entry from the same files in the same order as receiverAccess and writes nothing: the Mac's stub in Secure Preferences is off; an entry with a path and no reason is not off; no entry, or only the service's own keys, is not off; a file that cannot be read or is not a JSON object is unknown, never off", () => {
  const w = new World();
  try {
    const dir = join(w.paths.profile, "Default");
    mkdirSync(dir, { recursive: true });
    const secure = join(dir, "Secure Preferences");
    const put = (p: string, v: unknown) => writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
    const entry = (e: unknown) => ({ profile: { name: "Person 1" }, extensions: { settings: { [RECEIVER_ID]: e, otherextension: { disable_reasons: [1] } } } });
    const read = (mac?: boolean) => (mac === undefined ? receiverOff(w.paths.preferences) : receiverOff(w.paths.preferences, { mac }));
    assert.deepEqual(read(true), { unknown: "no Preferences file" }, "no file: unknown, as receiverAccess");
    // The Mac's case of 2026-11-24: the stub in Secure Preferences, and the service's own write in Preferences.
    put(w.paths.preferences, entry({ incognito: true, newAllowFileAccess: true }));
    put(secure, entry(STUB));
    assert.deepEqual(read(true), { off: true, reasons: [16777216], noPath: true });
    assert.deepEqual(read(false), { off: true, reasons: [16777216], noPath: false }, "Linux: the reason alone, no stub rule");
    assert.deepEqual(read(), read(false), "no mac: Linux");
    // The stub with no reason: off on the Mac only.
    put(secure, entry({ content_settings: [] }));
    assert.deepEqual(read(true), { off: true, reasons: [], noPath: true });
    assert.deepEqual(read(false), { off: false, entry: true });
    // A loaded receiver: a path, and no reason (an empty list, a list of 0, or no key).
    for (const e of [{ path: "/x/agent-package", location: 4, disable_reasons: [] }, { path: "/x/agent-package", location: 4, disable_reasons: [0] }, { path: "/x/agent-package", location: 4 }]) {
      put(secure, entry(e));
      assert.deepEqual(read(true), { off: false, entry: true }, JSON.stringify(e));
      assert.deepEqual(read(false), { off: false, entry: true }, JSON.stringify(e));
    }
    // Developer mode off with the entry kept (a path and the reason): off on both systems; any value that is not 0 counts.
    put(secure, entry({ path: "/x/agent-package", location: 4, disable_reasons: [0, 16777216] }));
    assert.deepEqual(read(true), { off: true, reasons: [16777216], noPath: false });
    // An older Chrome's single number.
    put(secure, entry({ path: "/x/agent-package", location: 4, disable_reasons: 4096 }));
    assert.deepEqual(read(false), { off: true, reasons: [4096], noPath: false });
    put(secure, entry({ path: "/x/agent-package", location: 4, disable_reasons: 0 }));
    assert.deepEqual(read(false), { off: false, entry: true });
    // Secure Preferences with no entry of the receiver: Preferences decides. The service's own keys there are not Chrome's
    // entry (a new Mac profile before the operator's first Load unpacked): not off, also on the Mac.
    put(secure, { protection: { macs: {} } });
    assert.deepEqual(read(true), { off: false, entry: false });
    assert.deepEqual(read(false), { off: false, entry: false });
    rmSync(secure);
    assert.deepEqual(read(true), { off: false, entry: false }, "no Secure Preferences: Preferences decides");
    // Preferences only (Linux's packed CRX): its entry decides.
    put(w.paths.preferences, entry({ path: "ifhf/0.1.0", location: 1, disable_reasons: [1], incognito: true, newAllowFileAccess: true }));
    assert.deepEqual(read(false), { off: true, reasons: [1], noPath: false });
    put(w.paths.preferences, entry({ path: "ifhf/0.1.0", location: 1, incognito: true, newAllowFileAccess: true }));
    assert.deepEqual(read(false), { off: false, entry: true });
    put(w.paths.preferences, entry({ location: 1 }));
    assert.deepEqual(read(false), { off: false, entry: true }, "Linux: no path is no stub");
    assert.deepEqual(read(true), { off: true, reasons: [], noPath: true }, "the Mac: Chrome's entry with no path");
    // No entry of the receiver: another extension's reasons do not count.
    put(w.paths.preferences, { extensions: { settings: { otherextension: { disable_reasons: [16777216] } } } });
    assert.deepEqual(read(true), { off: false, entry: false });
    // A file that cannot be read or is not a JSON object: unknown, never off.
    for (const bad of ["{\"extensions\":", "[1]"]) {
      put(secure, bad);
      assert.deepEqual(read(true), { unknown: "Secure Preferences is not a JSON object" }, bad);
    }
    // An entry in Secure Preferences decides before Preferences is read (as receiverAccess); with none there, a damaged
    // Preferences is unknown.
    put(w.paths.preferences, "{not json");
    put(secure, entry(STUB));
    assert.deepEqual(read(true), { off: true, reasons: [16777216], noPath: true });
    rmSync(secure);
    assert.deepEqual(read(true), { unknown: "Preferences is not a JSON object" });
    mkdirSync(secure); // a folder in place of the file: the read fails (EISDIR)
    assert.deepEqual(read(true), { unknown: "Secure Preferences cannot be read (EISDIR)" });
    rmSync(secure, { recursive: true });
    // The read writes nothing: the files' bytes and their inodes stay.
    put(w.paths.preferences, entry({ incognito: true, newAllowFileAccess: true }));
    put(secure, entry(STUB));
    const before = [readFileSync(w.paths.preferences, "utf8"), readFileSync(secure, "utf8")], ino = [statSync(w.paths.preferences).ino, statSync(secure).ino];
    read(true);
    assert.deepEqual([readFileSync(w.paths.preferences, "utf8"), readFileSync(secure, "utf8")], before);
    assert.deepEqual([statSync(w.paths.preferences).ino, statSync(secure).ino], ino);
    // receiverAccess stays as it was on the same files: the stub lacks both keys, and only the operator gives the incognito access.
    assert.deepEqual(receiverAccess(w.paths.preferences, { mac: true }), { state: "missing", missing: ["incognito", "file"], gives: "operator" });
  } finally { w.close(); }
});

test("board ab-v16.116: the off check's log line names the profile's folder only, the reasons and the stub; each result has its own key", () => {
  const profile = "/srv/state/profile";
  assert.equal(offLine("note", { off: true, reasons: [16777216], noPath: true }, profile, 7), `unit: at the watch's 15 s note Chrome has turned the receiver off in the profile "profile" (Chrome pid 7): disable_reasons 16777216; its entry has no path`);
  assert.equal(offLine("send", { off: true, reasons: [1, 4096], noPath: false }, profile, 7), `unit: at the end of a send's wait with no receiver Chrome has turned the receiver off in the profile "profile" (Chrome pid 7): disable_reasons 1 4096`);
  assert.equal(offLine("status", { off: true, reasons: [], noPath: true }, profile, 7), `unit: at the status read Chrome has turned the receiver off in the profile "profile" (Chrome pid 7): its entry has no path`);
  assert.equal(offLine("use", { off: false, entry: true }, profile, 7), `unit: at the end of a use's wait with no receiver the receiver's entry in the profile "profile" is not turned off (Chrome pid 7)`);
  assert.equal(offLine("stop", { off: false, entry: false }, profile, 7), `unit: at the watch's stop the profile "profile" holds no entry of the receiver (Chrome pid 7)`);
  assert.equal(offLine("send", { off: false, entry: false }, profile, null), `unit: at the end of a send's wait with no receiver the profile "profile" holds no entry of the receiver`, "no Chrome known: no pid");
  assert.equal(offLine("note", { unknown: "Preferences is not a JSON object" }, profile, 7), `unit: at the watch's 15 s note it is unknown whether Chrome turned the receiver off (the profile "profile": Preferences is not a JSON object)`);
  for (const l of [offLine("note", { off: true, reasons: [1], noPath: true }, profile, 7), offLine("note", { unknown: "x" }, profile, 7)]) assert.ok(!l.includes("/srv"), l);
  const keys: ReceiverOff[] = [{ off: true, reasons: [16777216], noPath: true }, { off: true, reasons: [16777216], noPath: false }, { off: true, reasons: [1], noPath: false }, { off: false, entry: true }, { off: false, entry: false }, { unknown: "x" }];
  assert.equal(new Set(keys.map((k) => offKey(k))).size, keys.length);
  assert.equal(offKey({ unknown: "x" }), offKey({ unknown: "y" }), "an unknown read is one result");
  assert.deepEqual(keys.map((k) => isOff(k)), [true, true, true, false, false, false]);
  assert.equal(isOff(null), false);
});

test("board ab-v16.94.31: after an adoption, the service's next own start (a stop, then a start) writes the receiver's incognito and file keys; the adoption itself writes no file of the profile", async () => {
  const w = new World();
  try {
    const { c, next } = await startedThenNewUnit(w);
    // The Chrome that runs (started before this service, with no write of its own): its profile has neither key.
    const p = JSON.parse(readFileSync(w.paths.preferences, "utf8"));
    p.extensions.settings[RECEIVER_ID] = { location: 1 };
    writeFileSync(w.paths.preferences, JSON.stringify(p));
    const before = readFileSync(w.paths.preferences, "utf8"), ino = statSync(w.paths.preferences).ino;
    const u2 = next();
    assert.equal(u2.adopt().adopted, true);
    assert.equal(u2.chromePid(), c.pid);
    assert.equal(readFileSync(w.paths.preferences, "utf8"), before, "the adoption writes nothing");
    assert.equal(statSync(w.paths.preferences).ino, ino);
    assert.deepEqual(receiverAccess(w.paths.preferences), { state: "missing", missing: ["incognito", "file"], gives: "service" });
    await u2.stop();
    await u2.start();
    assert.notEqual(u2.chromePid(), c.pid, "a Chrome of this service's own start");
    assert.deepEqual(JSON.parse(readFileSync(w.paths.preferences, "utf8")).extensions.settings[RECEIVER_ID], { location: 1, incognito: true, newAllowFileAccess: true });
    assert.deepEqual(receiverAccess(w.paths.preferences), { state: "ok" });
    await u2.stop();
  } finally { w.close(); }
});

test("a start with no config, with browser.enabled false or with a bad size is refused before any spawn; config's keys: enabled, chrome_bin (null or empty: Google Chrome), chrome_args, and agentwatch's display_size, lang and timezone", async () => {
  assert.deepEqual(configFrom({ enabled: true, control: true, chrome_bin: null, chrome_args: [], display_size: "1600x1000", lang: "fr-FR", timezone: "UTC", other: 1 }),
    { enabled: true, chromeBin: "", chromeArgs: [], displaySize: "1600x1000", lang: "fr-FR", timezone: "UTC" });
  assert.equal(configFrom({ enabled: false, chrome_bin: "/usr/bin/chromium", chrome_args: ["--x"] }).enabled, false);
  for (const [cfg, re] of [[null, /no config yet/], [{ ...CHROMIUM, enabled: false }, /browser.enabled is false/], [{ ...CHROMIUM, displaySize: "100x100" }, /display_size must be WIDTHxHEIGHT/]] as const) {
    const w = new World();
    try {
      const { u } = unitIn(w, { cfg: cfg as any });
      await assert.rejects(u.start(), re);
      assert.equal(w.spawned.length, 0);
    } finally { w.close(); }
  }
});

test("a Chrome that exits at once fails the start and its new Xvfb is stopped; a missing Xvfb or Chromium binary fails the start", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w);
    w.behave.chromium = ["exit"];
    await assert.rejects(u.start(), /Chromium exited at start/);
    assert.equal(w.named("Xvfb").length, 0, "its Xvfb is stopped");
    w.programs.Xvfb = null;
    await assert.rejects(u.start(), /Xvfb not found on PATH/);
    w.programs.Xvfb = "/usr/bin/Xvfb";
    w.programs["/usr/bin/chromium"] = null;
    await assert.rejects(u.start(), /Chromium not found: \/usr\/bin\/chromium/);
  } finally { w.close(); }
});

test("a start twice starts once; a stop waits for a start that runs", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w);
    await Promise.all([u.start(), u.start()]);
    assert.equal(chromeOf(w).length, 1);
    assert.equal(await u.start(), false);
    await u.stop();
    const s = u.start();
    while (!u.locked) await new Promise((r) => setImmediate(r));
    const stopped = u.stop(); // it waits for the start that holds the lock
    assert.equal(await s, true);
    await stopped;
    assert.equal(w.named("chromium").length, 0, "the stop came after the start");
    assert.equal(record(w).wanted, false);
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the owner rule before a start

test("the owner rule is asked right before each Chrome start: a no refuses the start with NotOwnerError and starts nothing", async () => {
  const w = new World();
  try {
    const asked: string[] = [];
    const { u } = unitIn(w, { mayAct: async (what) => { asked.push(what); return false; } });
    await assert.rejects(u.start(), NotOwnerError);
    assert.deepEqual(asked, ["a Chrome start"]);
    assert.equal(w.spawned.length, 0);
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the stop

test("stop: SIGTERM to Chrome, then to Xvfb; SIGKILL after 5 s; the record says wanted false; a pid whose command line changed is never signalled", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w);
    await u.start();
    const [x] = xvfbOf(w), [c] = chromeOf(w);
    w.stubborn.add("chromium");
    w.live.get(c.pid)!.stubborn = true;
    const t0 = w.now;
    assert.equal(await u.stop(), true);
    assert.deepEqual(w.signals, [[c.pid, "SIGTERM"], [c.pid, "SIGKILL"], [x.pid, "SIGTERM"]]);
    assert.ok(w.now - t0 >= 5000, "the grace");
    assert.equal(record(w).wanted, false);
    assert.equal(await u.stop(), false, "nothing was running");
    // A reused pid: the recorded Chrome's pid runs another program now.
    w.stubborn.clear();
    await u.start();
    const c2 = chromeOf(w).at(-1)!;
    w.end(c2.pid);
    w.add({ pid: c2.pid, start: c2.start, argv: ["/usr/bin/vim", "notes.txt"] });
    w.signals.length = 0;
    await u.stop();
    assert.equal(w.signals.some(([p]) => p === c2.pid), false, "the other program is never signalled");
    assert.ok(w.alive(c2.pid));
  } finally { w.close(); }
});

test("the stop also stops each Chrome on the profile that the unit does not hold (never one of another profile or a similar path)", async () => {
  const w = new World();
  try {
    const orphan = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`] });
    const child = w.add({ argv: ["/usr/lib/chromium/chromium", "--type=renderer", `--user-data-dir=${w.paths.profile}`], ppid: orphan.pid, pgrp: orphan.pid });
    const other = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}-2`] });
    const foreign = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`], uid: w.uid + 1 });
    const { u } = unitIn(w);
    await u.stop();
    assert.equal(w.alive(orphan.pid), false);
    assert.deepEqual(w.signals.map(([p]) => p), [orphan.pid], "only the root of the tree");
    assert.equal(w.alive(child.pid), true, "a child goes with its root (on a box)");
    assert.equal(w.alive(other.pid), true);
    assert.equal(w.alive(foreign.pid), true, "another user's process is never signalled");
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the adoption

async function startedThenNewUnit(w: World) {
  const { u } = unitIn(w);
  await u.start();
  const [x] = xvfbOf(w), [c] = chromeOf(w);
  return { x, c, next: () => unitIn(w).u };
}

test("the adoption after a restart: only what the record names, by pid and start time, on the agent profile and the X auth file, when the record says wanted", async () => {
  const w = new World();
  try {
    const { x, c, next } = await startedThenNewUnit(w);
    const u2 = next();
    assert.deepEqual(u2.adopt(), { adopted: true, wanted: true, unreadable: null });
    assert.equal(u2.running(), true);
    assert.equal(u2.chromePid(), c.pid);
    assert.equal(u2.runningDisplay(), 173);
    assert.equal(w.spawned.length, 2, "nothing new started");
    assert.deepEqual(w.signals, []);
    // The adopted unit stops them.
    await u2.stop();
    assert.equal(w.alive(c.pid) || w.alive(x.pid), false);
  } finally { w.close(); }
});

test("nothing is adopted unless everything matches: another start time (a reused pid), another profile, no X auth marker, another program as Xvfb, wanted false, or another user; the record's Xvfb alone gets SIGTERM", async () => {
  const cases: [string, (w: World, x: any, c: any) => void, boolean][] = [
    ["Chrome's start time differs", (w, _x, c) => { w.end(c.pid); w.add({ ...c, start: c.start + 1 }); }, true],
    ["Chrome on another profile", (w, _x, c) => { w.end(c.pid); w.add({ ...c, argv: ["/usr/bin/chromium", "--user-data-dir=/other"] }); }, true],
    ["Xvfb's start time differs", (w, x) => { w.end(x.pid); w.add({ ...x, start: x.start + 1 }); }, false],
    ["Xvfb without the X auth file", (w, x) => { w.end(x.pid); w.add({ ...x, argv: ["/usr/bin/Xvfb", ":173"] }); }, false],
    ["xauth names the file, not Xvfb", (w, x) => { w.end(x.pid); w.add({ ...x, argv: ["/usr/bin/xauth", "-f", w.paths.xauth, ":173"], exe: "/usr/bin/xauth" }); }, false],
    ["wanted false", (w) => { const r = record(w); writeJsonDurable(w.paths.unitFile, { ...r, wanted: false }); }, true],
    ["Chrome of another user", (w, _x, c) => { w.end(c.pid); w.add({ ...c, uid: w.uid + 1 }); }, true],
  ];
  for (const [what, change, xvfbStopped] of cases) {
    const w = new World();
    try {
      const { x, c, next } = await startedThenNewUnit(w);
      change(w, x, c);
      const u2 = next();
      assert.equal(u2.adopt().adopted, false, what);
      assert.equal(u2.running(), false, what);
      const sigs = w.signals.filter(([, s]) => s === "SIGTERM").map(([p]) => p);
      assert.deepEqual(sigs, xvfbStopped ? [x.pid] : [], `${what}: only the record's own Xvfb gets SIGTERM`);
      assert.equal(w.signals.some(([p]) => p === c.pid), false, `${what}: Chrome is never signalled by the adoption`);
    } finally { w.close(); }
  }
});

test("a record of agentwatch's daemon (no start times) is adopted by pid and markers, and the service writes the start times; no record adopts nothing", async () => {
  const w = new World();
  try {
    const { x, c, next } = await startedThenNewUnit(w);
    const r = record(w);
    delete r.xvfb_start; delete r.chrome_start;
    writeJsonDurable(w.paths.unitFile, r);
    const u2 = next();
    assert.equal(u2.adopt().adopted, true);
    assert.equal(record(w).chrome_start, c.start);
    assert.equal(record(w).xvfb_start, x.start);
  } finally { w.close(); }
  const w2 = new World();
  try {
    const { u } = unitIn(w2);
    assert.deepEqual(u.adopt(), { adopted: false, wanted: false, unreadable: null });
  } finally { w2.close(); }
});

test("an unreadable record is not no record: the owner finds Chrome on the profile and Xvfb by its X auth file (exactly one of each) and adopts them; with two it adopts nothing and stops nothing", async () => {
  const w = new World();
  try {
    const { c, next } = await startedThenNewUnit(w);
    writeFileSync(w.paths.unitFile, "{not json");
    const u2 = next();
    const a = u2.adopt();
    assert.deepEqual(a, { adopted: true, wanted: true, unreadable: "it is not JSON" });
    assert.equal(u2.chromePid(), c.pid);
    assert.equal(record(w).chrome_pid, c.pid, "a new record");
    writeFileSync(w.paths.unitFile, "[]");
    w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`] });
    const u3 = next();
    assert.equal(u3.adopt().adopted, false);
    assert.deepEqual(w.signals, [], "nothing is stopped");
  } finally { w.close(); }
});

test("an unreadable record (review-106 note 6): the adopted Chrome's kind, version and binary come from its program: a copy of the tools folder is Google Chrome of that copy's version, any other program Chromium", async () => {
  const w = new World();
  try {
    const tools = new FakeTools();
    tools.root = w.paths.chromes;
    tools.versions = ["158.0.7100.1-1"];
    const binary = tools.copy("158.0.7100.1-1").binary;
    const { u } = unitIn(w, { tools, cfg: DEFAULT_CONFIG });
    await u.start();
    assert.equal(chromeOf(w)[0].argv[0], binary);
    writeFileSync(w.paths.unitFile, "{not json");
    const u2 = unitIn(w, { tools, cfg: DEFAULT_CONFIG }).u;
    assert.equal(u2.adopt().adopted, true);
    assert.deepEqual(u2.chromeFacts(), { kind: KIND_GOOGLE, version: "158.0.7100.1-1" });
    assert.deepEqual([record(w).chrome, record(w).chrome_bin], [{ kind: KIND_GOOGLE, version: "158.0.7100.1-1" }, binary]);
  } finally { w.close(); }
  const w2 = new World();
  try {
    const { u } = unitIn(w2);
    await u.start();
    writeFileSync(w2.paths.unitFile, "{not json");
    const u2 = unitIn(w2).u;
    assert.equal(u2.adopt().adopted, true);
    assert.deepEqual(u2.chromeFacts(), { kind: KIND_CHROMIUM, version: "" });
    assert.deepEqual([record(w2).chrome, record(w2).chrome_bin], [{ kind: KIND_CHROMIUM, version: "" }, "/usr/bin/chromium"]);
  } finally { w2.close(); }
});

test("the boot sweep (stopOrphans) spares the adopted Chrome and every process below it, and stops a Chrome on the profile that no record names", async () => {
  const w = new World();
  try {
    const { c, next } = await startedThenNewUnit(w);
    const helper = w.add({ argv: ["/usr/lib/chromium/chrome_crashpad_handler"], ppid: c.pid });
    const below = w.add({ argv: ["/usr/lib/chromium/chromium", "--type=gpu-process", `--user-data-dir=${w.paths.profile}`], ppid: helper.pid });
    const orphan = w.add({ argv: ["/usr/bin/chromium", `--user-data-dir=${w.paths.profile}`] });
    const u2 = next();
    u2.adopt();
    assert.equal(await u2.stopOrphans(), true);
    assert.deepEqual(w.signals, [[orphan.pid, "SIGTERM"]]);
    assert.ok(w.alive(c.pid) && w.alive(below.pid));
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the supervisor

test("the supervisor's check comes every 5 s; its backoff runs from 1 s to 60 s", () => {
  assert.deepEqual([SUPERVISE_MS, BACKOFF_MIN_MS, BACKOFF_MAX_MS, HEALTHY_MS], [5000, 1000, 60_000, 300_000]);
});

test("the supervisor: a wanted Chrome that is gone starts again after the backoff (1 s, doubling), with its Xvfb when that is gone too; nothing happens when not wanted; it sends gone when it finds Chrome gone, before the backoff (board ab-b84.36), and a start sends ready", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w);
    const events: UnitEvent[] = [];
    await u.start();
    const [x, c] = [xvfbOf(w)[0], chromeOf(w)[0]];
    w.end(c.pid);
    const t0 = w.now;
    let goneAt: number | null = null;
    await u.superviseOnce((e) => { if (e.kind === "gone") goneAt = w.now; events.push(e); });
    assert.equal(goneAt, t0, "gone at once, before the backoff");
    assert.ok(w.now - t0 >= 1000, "the first backoff");
    assert.equal(chromeOf(w).length, 2, "Chrome again");
    assert.equal(xvfbOf(w).length, 1, "the same Xvfb");
    assert.ok(w.alive(x.pid));
    assert.deepEqual(events, [{ kind: "gone" }, { kind: "ready" }]);
    w.end(chromeOf(w)[1].pid); w.end(x.pid);
    await u.superviseOnce((e) => events.push(e));
    assert.deepEqual(w.logs.filter((l) => /is gone; starting it again in/.test(l)).map((l) => l.replace(/.* in /, "")), ["1 s", "2 s"], "the backoff doubles");
    assert.equal(xvfbOf(w).length, 2, "Xvfb again too");
    await u.stop();
    const n = w.spawned.length;
    await u.superviseOnce((e) => events.push(e));
    assert.equal(w.spawned.length, n, "not wanted: nothing");
  } finally { w.close(); }
});

test("the supervisor starts nothing before the first config (build note 8: the part starts a wanted Chrome at that config), and counts no failure", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w, { cfg: null });
    (u as any).wantedFlag = true;
    const t0 = w.now;
    for (let i = 0; i < 4; i++) await u.superviseOnce(() => assert.fail("no event"));
    assert.equal(w.now, t0, "no backoff, no try");
    assert.equal((u as any).failures, 0);
  } finally { w.close(); }
});

test("the supervisor reports start_failed once after three failed starts in a row (after one gone for the Chrome that it found gone); a NotOwnerError from the owner rule ends it", async () => {
  const w = new World();
  try {
    const { u } = unitIn(w);
    const events: UnitEvent[] = [];
    await u.start();
    w.end(chromeOf(w)[0].pid);
    w.behave.chromium = ["exit", "exit", "exit", "exit"];
    for (let i = 0; i < 4; i++) await u.superviseOnce((e) => events.push(e));
    assert.deepEqual(events.map((e) => e.kind), ["gone", "start_failed"], "gone once: the failed starts leave no Chrome to find gone");
    assert.match((events[1] as any).reason, /Chromium exited at start/);
    let ok = true;
    const w2 = new World();
    try {
      const { u: u2 } = unitIn(w2, { mayAct: async () => ok });
      await u2.start();
      w2.end(chromeOf(w2)[0].pid);
      ok = false;
      await assert.rejects(u2.superviseOnce(() => {}), NotOwnerError);
      assert.equal(chromeOf(w2).length, 1, "no restart when the service does not own");
    } finally { w2.close(); }
  } finally { w.close(); }
});

// ------------------------------------------------------------------ Google Chrome from the tools folder

test("chrome_bin empty runs the newest copy of the tools folder (never a failed one), with CHROME_VERSION_EXTRA; with no copy a start begins the install, waits for it, then runs the new copy", async () => {
  const w = new World();
  try {
    const tools = new FakeTools();
    tools.versions = ["157.0.7000.1-1", "156.0.6900.1-1"];
    w.programs[tools.copy("157.0.7000.1-1").binary] = tools.copy("157.0.7000.1-1").binary;
    const { u } = unitIn(w, { tools, cfg: DEFAULT_CONFIG });
    await u.start();
    const [c] = chromeOf(w);
    assert.equal(c.argv[0], tools.copy("157.0.7000.1-1").binary);
    assert.equal(c.env!.CHROME_VERSION_EXTRA, "stable");
    assert.deepEqual(u.chromeFacts(), { kind: KIND_GOOGLE, version: "157.0.7000.1-1" });
    assert.deepEqual(record(w).chrome, { kind: KIND_GOOGLE, version: "157.0.7000.1-1" });
    await u.stop();
    // No copy: the start installs.
    const w2 = new World();
    try {
      const t2 = new FakeTools();
      const { u: u2 } = unitIn(w2, { tools: t2, cfg: DEFAULT_CONFIG });
      const p = u2.start();
      for (let i = 0; i < 5 && !t2.pending; i++) await new Promise((r) => setImmediate(r));
      assert.deepEqual(t2.calls, ["ensure latest"]);
      assert.equal(u2.chromeInstalling(), true);
      t2.pending!.resolve();
      await p;
      assert.equal(chromeOf(w2)[0].argv[0], t2.copy("158.0.7100.1-1").binary);
    } finally { w2.close(); }
  } finally { w.close(); }
});

test("an install that runs longer than 45 s answers that Chrome is being installed, and goes on; a stop during the wait keeps the unit stopped; the supervisor never installs", async () => {
  const w = new World();
  try {
    const tools = new FakeTools();
    const { u } = unitIn(w, { tools, cfg: DEFAULT_CONFIG });
    await assert.rejects(u.start(), (e: Error) => e.message === CHROME_INSTALLING);
    assert.equal(u.chromeInstalling(), true);
    const p = u.start();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    await u.stop();
    tools.pending!.resolve();
    await assert.rejects(p, (e: Error) => e.message === STOPPED_DURING_INSTALL);
    assert.equal(chromeOf(w).length, 0);
    // The supervisor path (no fetch): with no copy and no recorded Chromium it says that Chrome is not installed.
    const w2 = new World();
    try {
      const t2 = new FakeTools();
      const { u: u2 } = unitIn(w2, { tools: t2, cfg: DEFAULT_CONFIG });
      (u2 as any).wantedFlag = true;
      const logs = w2.logs;
      await u2.superviseOnce(() => {});
      assert.deepEqual(t2.calls, [], "no install");
      assert.ok(logs.some((l) => l.includes(CHROME_NOT_INSTALLED)));
    } finally { w2.close(); }
  } finally { w.close(); }
});

test("a start runs the newest copy that did not fail, and with upto (the way back) the last good copy exactly", async () => {
  const w = new World();
  try {
    const tools = new FakeTools();
    tools.versions = ["157.0.7000.1-1", "158.0.7100.1-1", "159.0.7200.1-1"];
    for (const v of tools.versions) w.programs[tools.copy(v).binary] = tools.copy(v).binary;
    const u = new ChromeUnit(w.deps(tools, { displays: { first: 173, last: 175 }, refused: () => new Set(["159.0.7200.1-1"]) }));
    u.config = DEFAULT_CONFIG;
    await u.start();
    assert.equal(u.chromeFacts()!.version, "158.0.7100.1-1");
    await u.stop();
    await u.start({ upto: "157.0.7000.1-1" });
    assert.equal(u.chromeFacts()!.version, "157.0.7000.1-1");
  } finally { w.close(); }
});

// ------------------------------------------------------------------ the detached spawn and the record's write

test("spawnDetached: the process runs in its own session and process group with no stdio, and the service does not wait for it; signalGroup signals its group", { timeout: 20_000 }, async () => {
  const p = spawnDetached(["/bin/sleep", "30"], { PATH: "/usr/bin:/bin" });
  try {
    const procs = new Procs();
    const st = readFileSync(`/proc/${p.pid}/stat`, "latin1");
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    assert.equal(Number(f[2]), p.pid, "its own process group");
    assert.equal(Number(f[3]), p.pid, "its own session");
    assert.equal(readFileSync(`/proc/${p.pid}/fd/0`, { flag: "r" }).length, 0);
    signalGroup(procs)(p.pid, "SIGTERM");
    for (let i = 0; i < 100 && !p.exited(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(p.exited(), true);
  } finally { if (!p.exited()) process.kill(p.pid, "SIGKILL"); }
});

test("the unit record's write: a temp file of mode 0600 in the same folder, then the rename; no temp file stays", () => {
  const w = new World();
  try {
    mkdirSync(w.paths.state, { recursive: true });
    writeJsonDurable(w.paths.unitFile, { wanted: true });
    assert.equal(statSync(w.paths.unitFile).mode & 0o777, 0o600);
    assert.deepEqual(readRecord(w.paths.unitFile), { kind: "ok", record: { wanted: true } });
    assert.deepEqual(readFileSync(w.paths.unitFile, "utf8").trim().startsWith("{"), true);
    assert.deepEqual(readRecord(join(w.dir, "none.json")), { kind: "none" });
  } finally { w.close(); }
});
