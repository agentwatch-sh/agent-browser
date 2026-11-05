// The watcher of the macOS check (test/live/anti-detect/mac.ts, board task ab-v16.16). It logs what the
// operator's screen does while the check drives its own agent Chrome, and it gives the front back.
//
//   mac-watch BUNDLE_PATH SECONDS        (mac.ts compiles it into its run folder:
//                                         swiftc -swift-version 5 -O mac-watch.swift -o mac-watch)
//
// Standard output: one JSON object per line, "t" in ms since 1970 (as Date.now() in node), "ev" its kind:
//   ready     once, when it watches: the front app, the pointer, the Space, the displays, the lock state
//   front     the front app changed (also from NSWorkspace's activation news, so a change under 100 ms shows)
//   pointer   the pointer moved (the check never moves it: a move is a person at the Mac)
//   input     the hardware's key, modifier, button or scroll input after the watcher's start (once; a person at the Mac)
//   space     the active Space changed: NSWorkspace's news ("via": "news"), or a new id from CGSGetActiveSpace
//             ("via": "id"; a private CoreGraphics call, found with dlsym, read only; no id when it is missing)
//   windows   the on-screen windows of layer 0 changed (front to back: [pid, number, x, y, w, h, alpha x 100]),
//             or a "snap LABEL" command asked for them; a snap also lists every window of the agent Chrome
//             (on or off screen), the agent app's state (activation policy, hidden, active) and the front app
//   alive     once a second, with the Space id and the lock state, so a reader can tell a stopped watcher
//   take / ask / back / before   the give-back (below)
//   launched  NSWorkspace's news of an app launch (information only)
// Standard input: one command per line: "arm" and "disarm" (the give-back), "agent PID" (the agent Chrome's
// pid; before it, an agent Chrome is a new instance of BUNDLE_PATH that did not run at the watcher's start),
// "snap LABEL", "quit". It ends at "quit", when standard input closes (the check ended), or after SECONDS.
//
// The give-back, while armed: each time the agent Chrome is the front app, it asks macOS to activate the app
// that was in front before (NSRunningApplication.activate(options: [])), the same call as
// test/live/takeover/giveback.swift and src/giveback.ts, at once and again every 250 ms, at most 6 times for one
// take. When another app comes to the front while no take is in progress, that app is the one to give back to.
// At the first sign of a person it stops the give-back for good and logs "disarmed" with a "why": a pointer move
// ("pointer"), or a key press, a modifier key, a click or a scroll of the hardware after the watcher's start ("input":
// CGEventSource.secondsSinceLastEventType of the HID state, read only; the check sends no OS input, so such input is
// a person's). It reads both before it acts on a front change, so a switch that a person makes with the keyboard, the
// mouse or the trackpad (Cmd-Tab, a click on a window) is not undone. A switch with no hardware input (Voice Control,
// a script, another app) is not seen as a person's.
// It reads only, apart from that request: no input, no Apple Event, no pointer move, and no Accessibility,
// Automation or Screen Recording grant. It logs no window title (macOS gives none of other apps without Screen
// Recording), only the owner app's name.

import AppKit
import CoreGraphics
import Foundation

let maxAsks = 6
let retryMs = 250.0

func nowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }

func emit(_ ev: String, _ fields: [String: Any] = [:]) {
  var o = fields
  o["t"] = Int64(nowMs())
  o["ev"] = ev
  guard JSONSerialization.isValidJSONObject(o),
        let data = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]),
        let line = String(data: data, encoding: .utf8) else { return }
  print(line)
  fflush(stdout)
}

func number(_ v: Any?) -> Double { (v as? NSNumber)?.doubleValue ?? 0 }

/// One window of CGWindowListCopyWindowInfo.
struct Win {
  let pid: Int
  let n: Int
  let layer: Int
  let x: Double
  let y: Double
  let w: Double
  let h: Double
  let alpha: Double
  let onscreen: Bool
  let owner: String
}

func windowList(_ option: CGWindowListOption) -> [Win] {
  guard let raw = CGWindowListCopyWindowInfo(option, kCGNullWindowID) as NSArray? as? [[String: Any]] else { return [] }
  var out: [Win] = []
  for w in raw {
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    out.append(Win(
      pid: Int(number(w[kCGWindowOwnerPID as String])),
      n: Int(number(w[kCGWindowNumber as String])),
      layer: Int(number(w[kCGWindowLayer as String])),
      x: number(b["X"]), y: number(b["Y"]), w: number(b["Width"]), h: number(b["Height"]),
      alpha: number(w[kCGWindowAlpha as String]),
      onscreen: (w[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
      owner: w[kCGWindowOwnerName as String] as? String ?? "?"))
  }
  return out
}

/// CGSGetActiveSpace(CGSMainConnectionID()), when both symbols exist (private CoreGraphics; read only).
func activeSpaceReader() -> (() -> UInt64)? {
  typealias MainConnection = @convention(c) () -> Int32
  typealias ActiveSpace = @convention(c) (Int32) -> UInt64
  let any = UnsafeMutableRawPointer(bitPattern: -2) // RTLD_DEFAULT
  guard let m = dlsym(any, "CGSMainConnectionID"), let a = dlsym(any, "CGSGetActiveSpace") else { return nil }
  let main = unsafeBitCast(m, to: MainConnection.self)
  let active = unsafeBitCast(a, to: ActiveSpace.self)
  let connection = main()
  return { active(connection) }
}

final class Watcher {
  let bundle: String
  let old: Set<Int32>
  let started = nowMs()
  let limitMs: Double
  let spaceId: (() -> UInt64)?
  var agentPid: Int32 = 0
  var before: NSRunningApplication?
  var armed = false
  var takeAt: Double?
  var asks = 0
  var lastAsk = 0.0
  var lastFront: Int32 = -1
  var lastPoint = CGPoint(x: -1, y: -1)
  var lastWindows = ""
  var lastSpace: UInt64?
  var lastAlive = 0.0
  var personFound = false
  var personWhy = ""
  var inputLogged = false
  var readyAt = 0.0
  /// The hardware's input that only a person makes here (the HID state has no app's posted events).
  let personTypes: [(CGEventType, String)] = [(.keyDown, "keyDown"), (.flagsChanged, "flagsChanged"), (.leftMouseDown, "leftMouseDown"),
    (.rightMouseDown, "rightMouseDown"), (.otherMouseDown, "otherMouseDown"), (.scrollWheel, "scrollWheel")]

  init(bundle: String, seconds: Double) {
    self.bundle = bundle
    self.limitMs = seconds * 1000
    var pids = Set<Int32>()
    for app in NSWorkspace.shared.runningApplications where app.bundleURL?.standardizedFileURL.path == bundle { pids.insert(app.processIdentifier) }
    self.old = pids
    self.spaceId = activeSpaceReader()
  }

  func isAgent(_ app: NSRunningApplication) -> Bool {
    if agentPid != 0 { return app.processIdentifier == agentPid }
    return app.bundleURL?.standardizedFileURL.path == bundle && !old.contains(app.processIdentifier)
  }

  func appInfo(_ app: NSRunningApplication?) -> [String: Any] {
    guard let app = app else { return ["pid": 0, "name": "?", "agent": false] }
    return ["pid": Int(app.processIdentifier), "name": app.localizedName ?? "?", "bundle": (app.bundleIdentifier as Any?) ?? NSNull(), "agent": isAgent(app)]
  }

  func space() -> Any {
    guard let read = spaceId else { return NSNull() }
    return NSNumber(value: read())
  }

  func session() -> [String: Any] {
    let d = CGSessionCopyCurrentDictionary() as NSDictionary? as? [String: Any] ?? [:]
    let locked = (d["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
    let console = (d["kCGSSessionOnConsoleKey"] as? NSNumber)?.boolValue ?? true
    return ["locked": locked, "onConsole": console, "asleep": CGDisplayIsAsleep(CGMainDisplayID()) != 0]
  }

  func displays() -> [[String: Any]] {
    var count: UInt32 = 0
    _ = CGGetActiveDisplayList(0, nil, &count)
    let room = count
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(room))
    _ = CGGetActiveDisplayList(room, &ids, &count)
    return ids.prefix(Int(count)).map { id -> [String: Any] in
      let b = CGDisplayBounds(id)
      return ["id": Int(id), "x": Double(b.origin.x), "y": Double(b.origin.y), "w": Double(b.size.width), "h": Double(b.size.height), "main": CGDisplayIsMain(id) != 0]
    }
  }

  func pointer() -> CGPoint { CGEvent(source: nil)?.location ?? CGPoint(x: -1, y: -1) }

  /// The on-screen windows of layer 0, front to back, and their owners' names.
  func onscreen() -> ([[Int]], [String: String]) {
    var list: [[Int]] = []
    var owners: [String: String] = [:]
    for w in windowList([.optionOnScreenOnly, .excludeDesktopElements]) where w.layer == 0 {
      list.append([w.pid, w.n, Int(w.x.rounded()), Int(w.y.rounded()), Int(w.w.rounded()), Int(w.h.rounded()), Int((w.alpha * 100).rounded())])
      owners[String(w.pid)] = w.owner
    }
    return (list, owners)
  }

  func ready() {
    readyAt = Date().timeIntervalSince1970 * 1000
    before = NSWorkspace.shared.frontmostApplication
    lastFront = before?.processIdentifier ?? 0
    lastPoint = pointer()
    let s = space()
    if let n = s as? NSNumber { lastSpace = n.uint64Value }
    var o = session()
    o["front"] = appInfo(before)
    o["pointer"] = [Double(lastPoint.x), Double(lastPoint.y)]
    o["space"] = s
    o["spaceReader"] = spaceId != nil
    o["displays"] = displays()
    o["old"] = old.map { Int($0) }.sorted()
    emit("ready", o)
    checkWindows(force: "ready", label: nil)
  }

  func checkFront(_ app: NSRunningApplication?) {
    let pid = app?.processIdentifier ?? 0
    if pid != lastFront {
      lastFront = pid
      emit("front", appInfo(app))
    }
    checkPerson() // a person's input first: then no give-back acts on their own switch
    guard armed, let app = app, let b = before else { return }
    let t = nowMs()
    if isAgent(app) {
      if takeAt == nil { takeAt = t; asks = 0; emit("take", ["pid": Int(app.processIdentifier), "from": Int(b.processIdentifier)]) }
      if asks < maxAsks && (asks == 0 || t - lastAsk >= retryMs) {
        asks += 1
        lastAsk = t
        let sent = b.activate(options: [])
        emit("ask", ["to": Int(b.processIdentifier), "n": asks, "sent": sent])
      }
    } else if app.processIdentifier == b.processIdentifier {
      if let t0 = takeAt { emit("back", ["pid": Int(b.processIdentifier), "afterMs": Int(t - t0), "asks": asks]); takeAt = nil }
    } else if takeAt == nil {
      // Another app came to the front while the agent Chrome was not in front: the app to give the front back to.
      before = app
      emit("before", appInfo(app))
    }
  }

  /// A person at the Mac: the give-back stops for good.
  func personSeen(why: String) {
    if personFound { return }
    personFound = true
    personWhy = why
    armed = false
    takeAt = nil
    emit("disarmed", ["why": why])
  }

  func checkPerson() {
    let p = pointer()
    if abs(p.x - lastPoint.x) + abs(p.y - lastPoint.y) >= 1 {
      lastPoint = p
      emit("pointer", ["x": Double(p.x), "y": Double(p.y)])
      personSeen(why: "pointer")
    }
    if inputLogged || readyAt == 0 { return }
    let now = Date().timeIntervalSince1970 * 1000
    for (type, name) in personTypes {
      let at = now - CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: type) * 1000
      if at > readyAt + 5 {
        inputLogged = true
        emit("input", ["kind": name, "agoMs": Int((now - at).rounded())])
        personSeen(why: "input")
        return
      }
    }
  }

  func checkSpace(news: Bool) {
    let s = space()
    let id = (s as? NSNumber)?.uint64Value
    if news {
      lastSpace = id ?? lastSpace
      emit("space", ["via": "news", "space": s])
    } else if let id = id, id != lastSpace {
      lastSpace = id
      emit("space", ["via": "id", "space": s])
    }
  }

  func checkWindows(force why: String?, label: String?) {
    let (list, owners) = onscreen()
    let key = list.map { $0.map { String($0) }.joined(separator: ",") }.joined(separator: ";")
    if why == nil && key == lastWindows { return }
    lastWindows = key
    var o: [String: Any] = ["why": why ?? "change", "list": list, "owners": owners]
    if let label = label {
      o["label"] = label
      o["front"] = appInfo(NSWorkspace.shared.frontmostApplication)
      o["space"] = space()
      if agentPid != 0 {
        o["agentAll"] = windowList([.optionAll]).filter { $0.pid == Int(agentPid) }.map { w in
          ["n": w.n, "layer": w.layer, "x": w.x, "y": w.y, "w": w.w, "h": w.h, "alpha": w.alpha, "onscreen": w.onscreen] as [String: Any]
        }
        if let app = NSRunningApplication(processIdentifier: agentPid) {
          o["agentApp"] = ["pid": Int(agentPid), "policy": app.activationPolicy.rawValue, "hidden": app.isHidden, "active": app.isActive] as [String: Any]
        }
      }
    }
    emit("windows", o)
  }

  func tick() {
    let t = nowMs()
    checkFront(NSWorkspace.shared.frontmostApplication)
    checkPerson()
    checkSpace(news: false)
    checkWindows(force: nil, label: nil)
    if t - lastAlive >= 1000 {
      lastAlive = t
      var o = session()
      o["space"] = space()
      emit("alive", o)
    }
    if t - started > limitMs { finish("limit") }
  }

  func command(_ line: String) {
    let parts = line.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ", maxSplits: 1).map(String.init)
    guard let verb = parts.first else { return }
    switch verb {
    case "arm":
      if personFound { emit("disarmed", ["why": personWhy]); return }
      armed = true
      emit("armed")
      checkFront(NSWorkspace.shared.frontmostApplication)
    case "disarm":
      armed = false
      takeAt = nil
      emit("disarmed")
    case "agent":
      agentPid = Int32(parts.count > 1 ? parts[1] : "") ?? 0
      emit("agent", ["pid": Int(agentPid)])
    case "snap":
      checkWindows(force: "snap", label: parts.count > 1 ? parts[1] : "")
    case "quit":
      finish("quit")
    case "eof":
      finish("eof")
    default:
      emit("error", ["what": "unknown command", "line": line])
    }
  }

  func finish(_ why: String) {
    emit("end", ["why": why])
    exit(0)
  }
}

let args = CommandLine.arguments
guard args.count == 3, let seconds = Double(args[2]), seconds > 0, args[1].hasSuffix(".app") else {
  FileHandle.standardError.write(Data("usage: mac-watch BUNDLE_PATH SECONDS\n".utf8))
  exit(2)
}
let watcher = Watcher(bundle: URL(fileURLWithPath: args[1]).standardizedFileURL.path, seconds: seconds)
let center = NSWorkspace.shared.notificationCenter
_ = center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
  watcher.checkFront(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}
_ = center.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { _ in
  watcher.checkSpace(news: true)
}
_ = center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { note in
  let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
  emit("launched", ["pid": Int(app?.processIdentifier ?? 0), "name": app?.localizedName ?? "?"])
}
_ = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in watcher.tick() }
let reader = Thread {
  while let line = readLine() {
    DispatchQueue.main.async { watcher.command(line) }
  }
  DispatchQueue.main.async { watcher.command("eof") }
}
reader.start()
watcher.ready()
RunLoop.main.run()
