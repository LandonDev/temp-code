// computer-proof-probe: what scripts/e2e-tc-computer.ts, scripts/e2e-computer.ts and
// scripts/e2e-computer-schedule.ts read of the Mac to check tc-computer from outside it, and the
// input the schedule proof makes in the person's place. Run as `swift computer-proof-probe.swift
// <command>` (the proofs compile it once with swiftc instead, which is the same program). Each read
// prints one JSON line and exits; `idle --every`, `type` and `sentinel` print as they go.
//
//   pointer     {"x":..,"y":..}  the real pointer, global points, top-left origin
//   frontmost   {"pid":..,"bundleId":..}  the active app's pid (0 when there is none) and bundle id
//   frontwindow {"pid":..,"window":..}  the active app's pid and its frontmost on-screen window's
//               CGWindowID (0 when it shows none), read from the window list with no grant
//   frontwatch --every <ms>
//               the active app's pid sampled every tick, one line {"pid":..,"at":..} per change
//               (the first sample too) until killed: the front guard measurement's own record
//   idle        {"seconds":..}   since the last keyboard or pointer event of anyone's: a check of the
//               person's app and pointer is void when they touched the Mac during it
//   idle --every <ms>
//               the same, combined session state, one line per tick until killed
//   type --mark <four letters> --text <s> --every <ms> --for <ms>
//               key events at the HID tap carrying the mark in eventSourceUserData, one character of
//               the text (round and round) per tick, to whatever is frontmost; a line per key
//               {"key":..,"at":..} and {"typed":n} at the end
//   sentinel --allow-marks <four letters>,<four letters>
//               a listen-only tap on the input the service's person watch reads: the first event that
//               carries none of the marks prints {"person":true,"type":..,"at":..} and exits
//   pasteboard  {"changeCount":..}  the count alone
//   hide <pid>  {"hidden":..}    hides that app's windows, the first half of an abort when the
//               person comes back while a scratch app runs (the proof kills it next)
//   screen      {"locked":..,"asleep":..}  the session's screen lock (or another user on the console)
//               and the main display's sleep: an idle Mac that is locked or dark is no gap to run in
//   pasteboard save <file> | restore <file> | copy <text> | digest
//               the person's pasteboard kept aside and put back around the proof's own copy; digest is
//               a sha256 over every item's types and data
import AppKit
import CryptoKit

func emit(_ object: [String: Any], exitAfter: Bool = true) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([0x0A]))
    if exitAfter { exit(0) }
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

let args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
    guard let at = args.firstIndex(of: name), at + 1 < args.count else { return nil }
    return args[at + 1]
}
func millis(_ name: String) -> Int {
    guard let raw = option(name), let value = Int(raw), value > 0 else { fail("\(name) <ms> is required") }
    return value
}
/// "tccp" → 0x74636370: the four letters of a mark as eventSourceUserData carries them.
func fourCC(_ code: String) -> Int64 {
    let bytes = Array(code.utf8)
    guard bytes.count == 4 else { fail("a mark is four letters: \(code)") }
    return bytes.reduce(Int64(0)) { ($0 << 8) | Int64($1) }
}
let nowMs = { Int(Date().timeIntervalSince1970 * 1000) }
let anyInput = CGEventType(rawValue: ~0)!

switch args.first {
case "pointer":
    guard let point = CGEvent(source: nil)?.location else { fail("no pointer location") }
    emit(["x": Double(point.x), "y": Double(point.y)])

case "frontmost":
    let app = NSWorkspace.shared.frontmostApplication
    emit(["pid": Int(app?.processIdentifier ?? 0), "bundleId": app?.bundleIdentifier ?? NSNull()])

case "frontwindow":
    let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    // the list runs front to back; layer 0 is the ordinary window layer
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let top = list.first { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ($0[kCGWindowLayer as String] as? Int) == 0 }
    emit(["pid": Int(pid), "window": top?[kCGWindowNumber as String] as? Int ?? 0])

case "frontwatch":
    let every = millis("--every")
    var last: pid_t = -1
    Timer.scheduledTimer(withTimeInterval: Double(every) / 1000, repeats: true) { _ in
        let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        if pid != last {
            last = pid
            emit(["pid": Int(pid), "at": nowMs()], exitAfter: false)
        }
    }
    RunLoop.main.run()

case "idle" where args.count == 1:
    emit(["seconds": CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: anyInput)])

case "idle":
    let every = millis("--every")
    while true {
        emit(["seconds": CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput), "at": nowMs()], exitAfter: false)
        usleep(useconds_t(every * 1000))
    }

case "type":
    let mark = fourCC(option("--mark") ?? "tcpr")
    let text = Array(option("--text") ?? "x")
    let every = millis("--every")
    let span = millis("--for")
    guard !text.isEmpty else { fail("--text is empty") }
    let source = CGEventSource(stateID: .hidSystemState)
    let end = nowMs() + span
    var typed = 0
    repeat {
        let ch = String(text[typed % text.count])
        let units = Array(ch.utf16)
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { fail("no key event") }
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            event.setIntegerValueField(.eventSourceUserData, value: mark)
            event.post(tap: .cghidEventTap)
        }
        typed += 1
        emit(["key": ch, "at": nowMs()], exitAfter: false)
        if nowMs() + every > end { break }
        usleep(useconds_t(every * 1000))
    } while nowMs() < end
    emit(["typed": typed])

case "sentinel":
    guard let raw = option("--allow-marks") else { fail("--allow-marks <a,b> is required") }
    let allowed = Set(raw.split(separator: ",").map { fourCC(String($0)) })
    // the kinds the service's person watch takes (Input's WatchedEventType)
    let kinds: [CGEventType] = [.leftMouseDown, .rightMouseDown, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .keyDown, .flagsChanged, .scrollWheel, .otherMouseDown, .otherMouseDragged]
    let mask = kinds.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    let context = UnsafeMutableRawPointer(Unmanaged.passRetained(allowed as NSSet).toOpaque())
    let callback: CGEventTapCallBack = { _, type, event, refcon in
        let marks = Unmanaged<NSSet>.fromOpaque(refcon!).takeUnretainedValue()
        let mark = event.getIntegerValueField(.eventSourceUserData)
        if type.rawValue < 0xFFFF_FFFE, !marks.contains(NSNumber(value: mark)) {
            let data = try! JSONSerialization.data(withJSONObject: ["person": true, "type": Int(type.rawValue), "at": Int(Date().timeIntervalSince1970 * 1000)], options: [.sortedKeys])
            FileHandle.standardOutput.write(data + Data([0x0A]))
            exit(0)
        }
        return Unmanaged.passUnretained(event)
    }
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: callback, userInfo: context) else {
        fail("the listen-only tap was refused: TempCode needs Accessibility")
    }
    let loopSource = CFMachPortCreateRunLoopSource(nil, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), loopSource, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    emit(["armed": true, "at": nowMs()], exitAfter: false)
    CFRunLoopRun()

case "screen":
    let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
    let locked = session["CGSSessionScreenIsLocked"] as? Bool ?? false
    let onConsole = session["kCGSSessionOnConsoleKey"] as? Bool ?? true
    emit(["locked": locked || !onConsole, "asleep": CGDisplayIsAsleep(CGMainDisplayID()) != 0])

case "hide":
    guard args.count > 1, let pid = pid_t(args[1]) else { fail("usage: computer-proof-probe.swift hide <pid>") }
    emit(["hidden": NSRunningApplication(processIdentifier: pid)?.hide() ?? false])

case "pasteboard" where args.count == 1:
    emit(["changeCount": NSPasteboard.general.changeCount])

case "pasteboard":
    let board = NSPasteboard.general
    switch args[1] {
    case "save":
        guard args.count > 2 else { fail("pasteboard save <file>") }
        let items: [[String: String]] = (board.pasteboardItems ?? []).map { item in
            var saved: [String: String] = [:]
            for type in item.types { if let data = item.data(forType: type) { saved[type.rawValue] = data.base64EncodedString() } }
            return saved
        }
        let data = try! JSONSerialization.data(withJSONObject: items, options: [.sortedKeys])
        FileManager.default.createFile(atPath: args[2], contents: data, attributes: [.posixPermissions: 0o600])
        emit(["items": items.count, "changeCount": board.changeCount])
    case "restore":
        guard args.count > 2, let data = FileManager.default.contents(atPath: args[2]),
              let items = try? JSONSerialization.jsonObject(with: data) as? [[String: String]] else { fail("pasteboard restore <file>") }
        board.clearContents()
        let restored = items.map { saved -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, base64) in saved { if let bytes = Data(base64Encoded: base64) { item.setData(bytes, forType: NSPasteboard.PasteboardType(type)) } }
            return item
        }
        if !restored.isEmpty { board.writeObjects(restored) }
        emit(["items": restored.count, "changeCount": board.changeCount])
    case "copy":
        guard args.count > 2 else { fail("pasteboard copy <text>") }
        board.clearContents()
        board.setString(args[2], forType: .string)
        emit(["changeCount": board.changeCount, "at": nowMs()])
    case "digest":
        var hash = SHA256()
        for item in board.pasteboardItems ?? [] {
            for type in item.types.sorted(by: { $0.rawValue < $1.rawValue }) {
                hash.update(data: Data(type.rawValue.utf8))
                if let data = item.data(forType: type) { hash.update(data: data) }
            }
        }
        emit(["digest": hash.finalize().map { String(format: "%02x", $0) }.joined(), "changeCount": board.changeCount])
    default:
        fail("usage: pasteboard [save <file> | restore <file> | copy <text> | digest]")
    }

default:
    fail("usage: computer-proof-probe.swift pointer | frontmost | idle [--every <ms>] | type ... | sentinel ... | pasteboard [...] | screen | hide <pid>")
}
