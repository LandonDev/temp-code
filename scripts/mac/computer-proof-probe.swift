// computer-proof-probe: what scripts/e2e-tc-computer.ts reads of the Mac to check tc-computer from
// outside it. Run as `swift computer-proof-probe.swift <command>` (the proof compiles it once with
// swiftc instead, which is the same program). Each command prints one JSON line and exits.
//
//   pointer     {"x":..,"y":..}  the real pointer, global points, top-left origin
//   frontmost   {"pid":..}       the active app's pid, 0 when there is none
//   pasteboard  {"changeCount":..}  the count alone, never the contents: a read of the contents
//               could raise macOS's paste privacy prompt, and the proof leaves no prompt behind
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
    emit(["pid": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)])

case "pasteboard":
    emit(["changeCount": NSPasteboard.general.changeCount])

default:
    fail("usage: computer-proof-probe.swift pointer | frontmost | pasteboard")
}
