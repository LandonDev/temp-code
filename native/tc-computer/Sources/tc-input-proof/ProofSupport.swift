import AppKit
import ApplicationServices
import ComputerCore
import ComputerProtocol
import CoreGraphics
import Foundation
import Input

// Carbon's own Rect and Point come with AppKit; the wire's are meant here.
typealias Rect = ComputerProtocol.Rect
typealias Point = ComputerProtocol.Point

// What the proof needs beside Input: the Mac-wide locks over flock (the Service shell's job
// in the service), a small AX reader to find its scratch elements, the frontmost app and
// pointer before and after every step, the idle gate, and the report.

/// `flock` on `$TMPDIR/tc-computer/<name>`, as every service shares them (§1).
final class FlockLock: MacLock, @unchecked Sendable {
    let path: String

    init(_ name: String) {
        let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("tc-computer")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        path = (dir as NSString).appendingPathComponent(name)
    }

    func acquire(within seconds: Double) -> MacLockHold? {
        let fd = open(path, O_CREAT | O_RDWR, 0o644)
        guard fd >= 0 else { return nil }
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            if flock(fd, LOCK_EX | LOCK_NB) == 0 { return FlockHold(fd) }
            usleep(10_000)
        } while Date() < deadline
        close(fd)
        return nil
    }
}

final class FlockHold: MacLockHold, @unchecked Sendable {
    private let lock = NSLock()
    private var fd: Int32?
    init(_ fd: Int32) { self.fd = fd }
    func release() {
        lock.withLock {
            guard let f = fd else { return }
            flock(f, LOCK_UN)
            close(f)
            fd = nil
        }
    }
}

enum P {
    static func copy(_ e: AXUIElement, _ a: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
    }
    static func string(_ e: AXUIElement, _ a: String) -> String? { copy(e, a) as? String }
    static func number(_ e: AXUIElement, _ a: String) -> Double? { (copy(e, a) as? NSNumber)?.doubleValue }
    static func element(_ e: AXUIElement, _ a: String) -> AXUIElement? {
        guard let v = copy(e, a), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }
    static func children(_ e: AXUIElement) -> [AXUIElement] {
        ((copy(e, "AXChildren") as? [AnyObject]) ?? []).compactMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
    }
    static func actions(_ e: AXUIElement) -> [String] {
        var names: CFArray?
        return AXUIElementCopyActionNames(e, &names) == .success ? (names as? [String] ?? []) : []
    }
    static func settable(_ e: AXUIElement, _ a: String) -> Bool {
        var ok: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(e, a as CFString, &ok) == .success && ok.boolValue
    }
    static func set(_ e: AXUIElement, _ a: String, _ v: CFTypeRef) -> Bool {
        AXUIElementSetAttributeValue(e, a as CFString, v) == .success
    }
    static func frame(_ e: AXUIElement) -> Rect? {
        guard let p = copy(e, "AXPosition"), let s = copy(e, "AXSize") else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return Rect(x: point.x, y: point.y, w: size.width, h: size.height)
    }
    static func range(_ e: AXUIElement) -> [Int]? {
        guard let v = copy(e, "AXSelectedTextRange"), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var r = CFRange()
        guard AXValueGetValue(v as! AXValue, .cfRange, &r) else { return nil }
        return [r.location, r.length]
    }
    static func bounds(_ e: AXUIElement, _ location: Int, _ length: Int) -> Rect? {
        var cf = CFRange(location: location, length: length)
        guard let param = AXValueCreate(.cfRange, &cf) else { return nil }
        var out: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(e, "AXBoundsForRange" as CFString, param, &out) == .success, let v = out else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(v as! AXValue, .cgRect, &rect) else { return nil }
        return Rect(x: rect.origin.x, y: rect.origin.y, w: rect.size.width, h: rect.size.height)
    }
    /// Every element under `root`, breadth first.
    static func walk(_ root: AXUIElement, max: Int = 5_000) -> [AXUIElement] {
        var out: [AXUIElement] = [], queue = [root]
        while !queue.isEmpty, out.count < max {
            let e = queue.removeFirst()
            out.append(e)
            queue += children(e)
        }
        return out
    }
    /// The text a person would call the element by: title, description, identifier, placeholder.
    static func names(_ e: AXUIElement) -> [String] {
        ["AXTitle", "AXDescription", "AXIdentifier", "AXDOMIdentifier", "AXPlaceholderValue", "AXHelp"].compactMap { string(e, $0)?.lowercased() }
    }
}

/// The scratch window of one app, and what in it the legs act on.
struct Scratch {
    let pid: pid_t
    let app: AXUIElement
    let window: AXUIElement
    let windowID: UInt32
    var index = 0

    /// The first element of `role` (raw AX role) whose names contain `name`, or any of the role when `name` is nil.
    func find(_ role: String, _ name: String? = nil) -> AXUIElement? {
        P.walk(window).first { P.string($0, "AXRole") == role && (name == nil || P.names($0).contains { $0.contains(name!.lowercased()) }) }
    }

    mutating func resolve(_ e: AXUIElement) -> ResolvedElement {
        index += 1
        let settable = Set(["AXValue", "AXSelectedText", "AXSelectedTextRange", "AXFocused", "AXSelected"].filter { P.settable(e, $0) })
        let role = P.string(e, "AXRole") ?? "AXUnknown"
        return ResolvedElement(index: index, element: e, role: role, frame: P.frame(e) ?? Rect(x: 0, y: 0, w: 0, h: 0), actions: P.actions(e), settable: settable,
                               brief: ElementBrief(index: index, line: "\(role) \"\(P.names(e).first ?? "")\""))
    }

    var frame: Rect { P.frame(window) ?? Rect(x: 0, y: 0, w: 1, h: 1) }

    /// The session space of the window: its points at the display's scale.
    var space: CoordinateSpace {
        let f = frame, s = NSScreen.main?.backingScaleFactor ?? 2
        return CoordinateSpace(width: Int((f.w * s).rounded()), height: Int((f.h * s).rounded()), scale: s)
    }

    mutating func target(_ element: AXUIElement? = nil, start: AXUIElement? = nil, cursor: [Int]? = nil) -> InputTarget {
        InputTarget(pid: pid, windowID: windowID, windowFrame: frame, window: window, space: space,
                    element: element.map { resolve($0) }, startElement: start.map { resolve($0) }, cursor: cursor)
    }

    /// A screen point as a coordinate of the space.
    func coordinate(_ p: CGPoint) -> [Int] {
        let f = frame, s = space.scale
        return [Int(((p.x - f.x) * s).rounded()), Int(((p.y - f.y) * s).rounded())]
    }

    /// The scratch app the script launched, by its pid, and its window whose title holds `title` (else its first).
    static func open(pid: pid_t, title: String?) -> Scratch? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 2)
        let windows = ((P.copy(app, "AXWindows") as? [AnyObject]) ?? []).map { $0 as! AXUIElement }
        guard let w = windows.first(where: { title == nil || (P.string($0, "AXTitle") ?? "").contains(title!) }) ?? windows.first else { return nil }
        return Scratch(pid: pid, app: app, window: w, windowID: windowNumber(w, pid: pid) ?? 0)
    }

    static func windowNumber(_ w: AXUIElement, pid: pid_t) -> UInt32? {
        guard let f = P.frame(w), let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for info in list where (info[kCGWindowOwnerPID as String] as? Int) == Int(pid) {
            guard let b = info[kCGWindowBounds as String] as? [String: Double] else { continue }
            if abs((b["X"] ?? 0) - f.x) < 1, abs((b["Y"] ?? 0) - f.y) < 1, abs((b["Width"] ?? 0) - f.w) < 1 {
                return (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value
            }
        }
        return nil
    }
}

/// The Mac's state a tier 1 or 2 step must leave as it found it.
struct MacState: Equatable {
    let frontmost: pid_t?
    let pointer: CGPoint

    static func now() -> MacState {
        MacState(frontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier, pointer: CGEvent(source: nil)?.location ?? .zero)
    }
}

/// Seconds since the last keyboard or mouse event of the HID system (ioreg's HIDIdleTime).
func hidIdle() -> Double {
    CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
}

/// The person's quiet, told apart from the proof's own session-tier events: polled between
/// steps, any input after the last step ended is the person's.
final class IdleGate: @unchecked Sendable {
    /// how long the Mac must have been quiet before a session step (the person's rule: 2 minutes)
    let needed: Double
    private var quietSince: Date
    private var ownUntil = Date.distantPast
    /// Input's own watch, armed for the whole session leg: any input event without the mark
    /// (the person's) latches it, between steps and through every check's wait alike.
    private let watch = PersonWatch()

    init(needed: Double) {
        self.needed = needed
        quietSince = Date().addingTimeInterval(-hidIdle())
    }

    /// From here on any unmarked input is the person's and ends the session leg.
    func watchPerson() {
        watch.arm {}
    }

    func stopWatching() {
        watch.disarm()
    }

    /// The person's unmarked input reached the leg's watch: nothing more of theirs is taken or put back.
    var personTookOver: Bool { watch.tripped }

    /// Reads the HID idle time; an input later than the proof's own last step is the person's.
    /// The proof's events are all posted before `stepEnded()`, so the grace is short.
    func sample() {
        let last = Date().addingTimeInterval(-hidIdle())
        if last > ownUntil.addingTimeInterval(0.05), last > quietSince { quietSince = last }
    }

    /// The person moved during a step (the engine's watch said so): their quiet starts again now.
    func personActive() {
        quietSince = Date()
    }

    /// The proof's own session step ran from now until `stepEnded()`.
    func stepStarted() { ownUntil = .distantFuture }
    func stepEnded() { ownUntil = Date() }

    var quietFor: Double { Date().timeIntervalSince(quietSince) }

    /// Waits until the person has been quiet `needed` seconds, sampling every second, at most `maxWait`.
    func waitQuiet(maxWait: Double) -> Bool {
        let deadline = Date().addingTimeInterval(maxWait)
        while true {
            sample()
            if quietFor >= needed { return true }
            if Date() > deadline { return false }
            Thread.sleep(forTimeInterval: 1)
        }
    }

    /// Whether the person stayed quiet: true only when no input since the last check was theirs and the 2 minutes still hold.
    func stillQuiet() -> Bool {
        sample()
        return !watch.tripped && quietFor >= needed
    }
}

struct LegResult: Codable {
    var app: String
    var leg: String
    var tiers: [String]
    var ok: Bool
    var tier: String?
    var via: String?
    var clipboard: String?
    var detail: String
    var ms: Double
    var frontmostMoved = false
    var pointerMoved = false
    var retries = 0
    var skipped: String?
    var error: String?
    var session: String?
}

struct ProbeLine: Codable {
    var app: String
    var keyWindow: String
    var results: [String: String]
    var restored: Bool
    var ms: Int
}

final class Report: @unchecked Sendable {
    var legs: [LegResult] = []
    var probes: [ProbeLine] = []
    var notes: [String] = []

    func write(to path: String) throws {
        let json: [String: Any] = [
            "legs": try JSONSerialization.jsonObject(with: JSONEncoder().encode(legs)),
            "probes": try JSONSerialization.jsonObject(with: JSONEncoder().encode(probes)),
            "notes": notes,
            "pass": legs.allSatisfy { $0.ok || $0.skipped != nil }
        ]
        try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: path))
        try markdown().write(toFile: (path as NSString).deletingPathExtension + ".md", atomically: true, encoding: .utf8)
    }

    /// The report as a table per app: each leg, the tier it used, what it saw, its time.
    func markdown() -> String {
        var out = ["# Input proof", ""]
        for app in Array(Set(legs.map(\.app))).sorted() {
            out += ["## \(app)", "", "| leg | tiers | used | result | ms |", "|---|---|---|---|---|"]
            for l in legs where l.app == app {
                let result = l.skipped ?? (l.ok ? "ok: \(l.detail)" : "FAIL: \(l.detail)\(l.error.map { " (\($0))" } ?? "")")
                out.append("| \(l.leg) | \(l.tiers.joined(separator: ",")) | \(l.tier ?? "-")\(l.via.map { " \($0)" } ?? "") | \(result.replacingOccurrences(of: "|", with: "/")) | \(Int(l.ms)) |")
            }
            out.append("")
        }
        if !probes.isEmpty {
            out += ["## probes", "", "| app | key window | scroll | key | click | restored | ms |", "|---|---|---|---|---|---|---|"]
            for p in probes { out.append("| \(p.app) | \(p.keyWindow) | \(p.results["scroll"] ?? "-") | \(p.results["key"] ?? "-") | \(p.results["click"] ?? "-") | \(p.restored) | \(p.ms) |") }
            out.append("")
        }
        if !notes.isEmpty { out += ["## notes", ""] + notes.map { "- \($0)" } }
        return out.joined(separator: "\n") + "\n"
    }
}
