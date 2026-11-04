// The give-back helper of the live start check (start.ts --variant give-back, ab-b84.11): phase 1's guard,
// kept to compare with the built-in give-back of src/giveback.ts (the same AppKit call, from JavaScript for
// Automation). At its start it records the frontmost app. Then, for SECONDS, each time a new instance of the
// app at BUNDLE_PATH (one that did not run at the helper's start: the agent Chrome that the check starts)
// becomes the frontmost app, it asks macOS to activate the recorded app again
// (NSRunningApplication.activate(options: [])), and it logs one JSON line per request:
//   {"t": ..., "before": pid, "name": ...}                                       first line: it watches now
//   {"t": ..., "took": pid, "name": ..., "gaveBackTo": pid, "sent": true|false}   a request
// "sent" is AppKit's answer: the request was sent, not that macOS granted it. On macOS 14 and later
// (cooperative activation) macOS can refuse it, because the helper is never the active app; the monitor
// shows what happened. It reads the front app ten times a second and on each NSWorkspace activation, as
// monitor.swift does. It sends no input and no Apple Event, and it needs no Accessibility, Automation or
// Screen Recording grant. Compile: swiftc -swift-version 5 -O giveback.swift -o giveback
import AppKit

func now() -> String { String(format: "%.3f", Date().timeIntervalSince1970) }
/// A JSON string literal: an app name can hold a quote or a backslash.
func quoted(_ s: String) -> String {
  guard let data = try? JSONSerialization.data(withJSONObject: [s]), let array = String(data: data, encoding: .utf8) else { return "\"?\"" }
  return String(array.dropFirst().dropLast())
}
func die(_ message: String, _ code: Int32) -> Never {
  FileHandle.standardError.write(Data("giveback: \(message)\n".utf8))
  exit(code)
}

let args = CommandLine.arguments
guard args.count == 3, let seconds = Double(args[2]), seconds > 0 else { die("usage: giveback BUNDLE_PATH SECONDS", 2) }
let bundle = URL(fileURLWithPath: args[1]).standardizedFileURL.path
guard let before = NSWorkspace.shared.frontmostApplication else { die("no frontmost app", 1) }
// The instances of the bundle that run now (for example the operator's own Google Chrome) are never the new one.
// The bundle test is written inline, not as a top-level function: swiftc warned that such a function must be
// @Sendable (an error in Swift 6 mode).
let old = Set(NSWorkspace.shared.runningApplications.filter { $0.bundleURL?.standardizedFileURL.path == bundle }.map { $0.processIdentifier })

var lastPid: Int32 = before.processIdentifier
/// One request each time a new instance of the bundle becomes the front app.
func check(_ app: NSRunningApplication?) {
  guard let app = app, app.processIdentifier != lastPid else { return }
  lastPid = app.processIdentifier
  guard app.bundleURL?.standardizedFileURL.path == bundle, !old.contains(app.processIdentifier) else { return }
  let sent = before.activate(options: [])
  print("{\"t\": \(now()), \"took\": \(app.processIdentifier), \"name\": \(quoted(app.localizedName ?? "?")), \"gaveBackTo\": \(before.processIdentifier), \"sent\": \(sent)}")
  fflush(stdout)
}
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
  check(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
}
let started = Date()
Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
  check(NSWorkspace.shared.frontmostApplication)
  if Date().timeIntervalSince(started) > seconds { exit(0) }
}
// The first line comes after the observer and the timer are set up: from now on the helper watches.
print("{\"t\": \(now()), \"before\": \(before.processIdentifier), \"name\": \(quoted(before.localizedName ?? "?"))}")
fflush(stdout)
RunLoop.main.run()
