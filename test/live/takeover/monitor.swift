// Logs every change of the frontmost app (pid) and of the pointer position, 10 times a second, for
// N seconds: one JSON line per change. Reads only; needs no Accessibility or Screen Recording grant.
import AppKit

let seconds = Double(CommandLine.arguments.dropFirst().first ?? "120") ?? 120
let started = Date()
var lastPid: Int32 = -1
var lastPoint = CGPoint(x: -1, y: -1)
func now() -> String { String(format: "%.3f", Date().timeIntervalSince1970) }
Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
  let app = NSWorkspace.shared.frontmostApplication
  let pid = app?.processIdentifier ?? 0
  if pid != lastPid {
    lastPid = pid
    print("{\"t\": \(now()), \"front\": \(pid), \"name\": \"\(app?.localizedName ?? "?")\"}")
  }
  let p = CGEvent(source: nil)?.location ?? .zero
  if abs(p.x - lastPoint.x) + abs(p.y - lastPoint.y) >= 1 {
    lastPoint = p
    print("{\"t\": \(now()), \"pointer\": [\(Int(p.x)), \(Int(p.y))]}")
  }
  fflush(stdout)
  if Date().timeIntervalSince(started) > seconds { exit(0) }
}
RunLoop.main.run()
