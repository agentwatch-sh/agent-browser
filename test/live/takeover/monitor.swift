// Logs every change of the frontmost app (pid) and of the pointer position for N seconds: one JSON line
// per change. It reads both 10 times a second, and it also logs each app activation that NSWorkspace
// announces, so a front change shorter than 100 ms is seen too. When it cannot see the front app, it
// logs pid 0 and the name "?". Once a second it prints {"t": ..., "alive": true}, so a reader can tell
// a hung or stopped monitor from a quiet screen. It also logs each app launch that NSWorkspace announces
// as {"t": ..., "launched": pid, "name": ...}, for information only (not verified for `open -g`). Reads
// only; needs no Accessibility or Screen Recording grant. Compile: swiftc -swift-version 5 -O monitor.swift -o monitor
import AppKit

let seconds = Double(CommandLine.arguments.dropFirst().first ?? "120") ?? 120
let started = Date()
var lastPid: Int32 = -1
var lastPoint = CGPoint(x: -1, y: -1)
func now() -> String { String(format: "%.3f", Date().timeIntervalSince1970) }
/// A JSON string literal: an app name can hold a quote or a backslash.
func quoted(_ s: String) -> String {
  guard let data = try? JSONSerialization.data(withJSONObject: [s]), let array = String(data: data, encoding: .utf8) else { return "\"?\"" }
  return String(array.dropFirst().dropLast())
}
func logFront(_ app: NSRunningApplication?) {
  let pid = app?.processIdentifier ?? 0
  if pid != lastPid {
    lastPid = pid
    print("{\"t\": \(now()), \"front\": \(pid), \"name\": \(quoted(app?.localizedName ?? "?"))}")
    fflush(stdout)
  }
}
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
  logFront(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { note in
  let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
  print("{\"t\": \(now()), \"launched\": \(app?.processIdentifier ?? 0), \"name\": \(quoted(app?.localizedName ?? "?"))}")
  fflush(stdout)
}
Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
  print("{\"t\": \(now()), \"alive\": true}")
  fflush(stdout)
}
Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
  logFront(NSWorkspace.shared.frontmostApplication)
  let p = CGEvent(source: nil)?.location ?? .zero
  if abs(p.x - lastPoint.x) + abs(p.y - lastPoint.y) >= 1 {
    lastPoint = p
    print("{\"t\": \(now()), \"pointer\": [\(Int(p.x)), \(Int(p.y))]}")
  }
  fflush(stdout)
  if Date().timeIntervalSince(started) > seconds { exit(0) }
}
RunLoop.main.run()
