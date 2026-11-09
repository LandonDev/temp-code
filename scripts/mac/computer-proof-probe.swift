// computer-proof-probe: what scripts/e2e-tc-computer.ts and scripts/e2e-computer.ts read of the Mac to check tc-computer from
// outside it. Run as `swift computer-proof-probe.swift <command>` (the proof compiles it once with
// swiftc instead, which is the same program). Each command prints one JSON line and exits.
//
//   pointer     {"x":..,"y":..}  the real pointer, global points, top-left origin
//   frontmost   {"pid":..,"bundleId":..}  the active app's pid (0 when there is none) and bundle id
//   idle        {"seconds":..}   since the last keyboard or pointer event of anyone's: a check of the
//               person's app and pointer is void when they touched the Mac during it
//   pasteboard  {"changeCount":..}  the count alone, never the contents: a read of the contents
//               could raise macOS's paste privacy prompt, and the proof leaves no prompt behind
//   hide <pid>  {"hidden":..}    hides that app's windows, the first half of an abort when the
//               person comes back while a scratch app runs (the proof kills it next)
//   screen      {"locked":..,"asleep":..}  the session's screen lock (or another user on the console)
//               and the main display's sleep: an idle Mac that is locked or dark is no gap to run in
import AppKit

func emit(_ object: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([0x0A]))
    exit(0)
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

switch CommandLine.arguments.dropFirst().first {
case "pointer":
    guard let point = CGEvent(source: nil)?.location else { fail("no pointer location") }
    emit(["x": Double(point.x), "y": Double(point.y)])

case "frontmost":
    let app = NSWorkspace.shared.frontmostApplication
    emit(["pid": Int(app?.processIdentifier ?? 0), "bundleId": app?.bundleIdentifier ?? NSNull()])

case "idle":
    let anyInput = CGEventType(rawValue: ~0)!
    emit(["seconds": CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: anyInput)])

case "pasteboard":
    emit(["changeCount": NSPasteboard.general.changeCount])

case "screen":
    let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
    let locked = session["CGSSessionScreenIsLocked"] as? Bool ?? false
    let onConsole = session["kCGSSessionOnConsoleKey"] as? Bool ?? true
    emit(["locked": locked || !onConsole, "asleep": CGDisplayIsAsleep(CGMainDisplayID()) != 0])

case "hide":
    guard let arg = CommandLine.arguments.dropFirst(2).first, let pid = pid_t(arg) else { fail("usage: computer-proof-probe.swift hide <pid>") }
    emit(["hidden": NSRunningApplication(processIdentifier: pid)?.hide() ?? false])

default:
    fail("usage: computer-proof-probe.swift pointer | frontmost | idle | pasteboard | screen | hide <pid>")
}
