#if canImport(ApplicationServices)
import AppKit
import ApplicationServices
import AXReader
import AXText
import ComputerCore
import ComputerProtocol
import Foundation

/// tc-ax's live commands. They read only an allowed pid's exactly named window
/// and never raise or activate one; `poke` acts through AX on a resolved element
/// only to make the proof's changes (input proper is the Input tiers').
enum Live {
    static func run(_ args: Args) {
        guard AXIsProcessTrusted() else { fail("Accessibility is not granted to this process", code: 8) }
        let pid = pid_t(args.int("pid", 0))
        let allow = Set((ProcessInfo.processInfo.environment["TC_AX_ALLOW_PIDS"] ?? "").split(separator: ",").compactMap { pid_t($0.trimmingCharacters(in: .whitespaces)) })
        guard pid > 0, allow.contains(pid) else { fail("refused: pid \(pid) is not in TC_AX_ALLOW_PIDS", code: 3) }
        if args.command == "windows" {
            struct W: Encodable { var id: Int; var title: String; var onScreen: Bool; var minimized: Bool }
            emit(AppWindows.list(pid: pid).map { W(id: $0.id, title: $0.title, onScreen: $0.onScreen, minimized: $0.minimized) })
            return
        }
        guard let title = args.options["expect-title"] else { fail("\(args.command) needs --expect-title") }
        guard let window = AppWindows.list(pid: pid).first(where: { $0.title == title }) else {
            fail("refused: pid \(pid) has no window titled exactly \(Quote.json(title))", code: 4)
        }
        let reader: AppReader
        do {
            reader = try AXReaders().reader(session: "tc-ax", pid: pid)
        } catch {
            fail("\(error)")
        }
        let space = CoordinateSpace(width: max(1, Int(window.frame.w.rounded())), height: max(1, Int(window.frame.h.rounded())), scale: 1)
        let ref = ComputerProtocol.WindowRef(id: window.id)
        switch args.command {
        case "observe":
            answer { try observe(reader, ref, space, options: args.options, flags: args.flags) }
        case "session":
            session(reader, ref, space)
        case "bench":
            bench(reader, ref, space, args)
        default:
            fail("unknown command \(args.command)")
        }
    }

    struct Failure: Encodable { var ok = false; var error: ComputerError }

    /// One JSON line: the answer, or the ComputerError it threw.
    static func answer<T: Encodable>(_ body: () throws -> T) {
        do {
            emit(try body())
        } catch let f as ComputerFailure {
            emit(Failure(error: f.error))
        } catch {
            emit(Failure(error: ComputerError(kind: .unknown("error"), message: "\(error)")))
        }
    }

    struct Observed: Encodable {
        var ok = true
        var kind: String
        var text: String
        var stats: ObservationStats
        var window: WindowInfo
        var focused: Int?
        var walkMs: Double
        var buildMs: Double
        var chromium: Bool?
    }

    static func observe(_ reader: AppReader, _ ref: ComputerProtocol.WindowRef, _ space: CoordinateSpace, options: [String: String], flags: Set<String>) throws -> Observed {
        let request = ObserveRequest(window: ref, mode: options["mode"] == "full" ? .full : .auto, element: options["element"].flatMap(Int.init),
                                     budgetBytes: options["budget"].flatMap(Int.init) ?? ComputerDefaults.ObservationBudget.defaultBytes,
                                     geometry: flags.contains("geometry"), menus: flags.contains("menus"), space: space,
                                     loading: options["loading"] == "true", noteThin: true)
        let o = try reader.observe(request)
        return Observed(kind: o.kind.rawValue, text: o.text, stats: o.stats, window: o.window, focused: o.focused, walkMs: reader.lastWalkMs, buildMs: reader.lastBuildMs, chromium: reader.chromium)
    }

    /// JSON lines on stdin, one answer a line:
    /// `observe {"mode":"full","menus":true,"geometry":true,"budget":4000,"element":12}`, `resolve <i>`,
    /// `poke set-value <i> "<json string>"`, `poke select <i> <a> <b>`, `poke press <i>`, `poke action <i> <AXName>`,
    /// `signature`, `busy`, `last-change`, `quit`.
    static func session(_ reader: AppReader, _ ref: ComputerProtocol.WindowRef, _ space: CoordinateSpace) {
        struct Ok: Encodable { var ok = true }
        struct Resolved: Encodable { var ok = true; var index: Int; var role: String; var line: String; var frame: ComputerProtocol.Rect; var actions: [String]; var settable: [String] }
        struct Sig: Encodable { var ok = true; var signature: String; var ms: Double }
        struct Busy: Encodable { var ok = true; var busy: Bool; var ms: Double }
        struct Last: Encodable { var ok = true; var lastChange: String; var ageMs: Double? }
        while let line = readLine() {
            let words = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true).map(String.init)
            guard let verb = words.first else { continue }
            switch verb {
            case "quit":
                return
            case "observe":
                answer {
                    let rest = line.dropFirst("observe".count).trimmingCharacters(in: .whitespaces)
                    let json = rest.isEmpty ? [:] : ((try? JSONSerialization.jsonObject(with: Data(rest.utf8))) as? [String: Any] ?? [:])
                    var options: [String: String] = [:]
                    var flags: Set<String> = []
                    for (k, v) in json {
                        if let b = v as? Bool { if b { flags.insert(k) }; options[k] = b ? "true" : "false" } else { options[k] = "\(v)" }
                    }
                    return try observe(reader, ref, space, options: options, flags: flags)
                }
            case "resolve":
                answer {
                    let r = try reader.resolve(Int(words.count > 1 ? words[1] : "") ?? 0)
                    return Resolved(index: r.index, role: r.role, line: r.brief.line, frame: r.frame, actions: r.actions, settable: r.settable.sorted())
                }
            case "poke":
                answer {
                    guard words.count >= 3, let i = Int(words[2]) else { throw ComputerFailure(.unknown("usage"), "poke <set-value|select|press|action> <i> …") }
                    let el = try reader.resolve(i).element
                    let rest = words.count > 3 ? words[3] : ""
                    var e = AXError.success
                    switch words[1] {
                    case "set-value":
                        let text = (try? JSONDecoder().decode(String.self, from: Data(rest.utf8))) ?? rest
                        e = AXUIElementSetAttributeValue(el, "AXValue" as CFString, text as CFString)
                    case "select":
                        let n = rest.split(separator: " ").compactMap { Int($0) }
                        guard n.count == 2 else { throw ComputerFailure(.unknown("usage"), "poke select <i> <a> <b>") }
                        var range = CFRange(location: n[0], length: n[1] - n[0])
                        e = AXUIElementSetAttributeValue(el, "AXSelectedTextRange" as CFString, AXValueCreate(.cfRange, &range)!)
                    case "press":
                        e = AXUIElementPerformAction(el, "AXPress" as CFString)
                    case "action":
                        e = AXUIElementPerformAction(el, rest as CFString)
                    default:
                        throw ComputerFailure(.unknown("usage"), "poke <set-value|select|press|action> <i> …")
                    }
                    guard e == .success else { throw ComputerFailure(.actionUnsupported, "AX answered \(e.rawValue)") }
                    return Ok()
                }
            case "signature":
                answer {
                    let start = ContinuousClock.now
                    let s = reader.changes.signature()
                    return Sig(signature: String(s), ms: ms(since: start))
                }
            case "busy":
                answer {
                    let start = ContinuousClock.now
                    let b = reader.changes.busyIndicatorShowing()
                    return Busy(busy: b, ms: ms(since: start))
                }
            case "last-change":
                answer {
                    let last = reader.changes.lastChange
                    var base = mach_timebase_info_data_t()
                    mach_timebase_info(&base)
                    let age = last == 0 ? nil : Double(mach_absolute_time() - last) * Double(base.numer) / Double(base.denom) / 1_000_000
                    return Last(lastChange: String(last), ageMs: age)
                }
            default:
                emit(Failure(error: ComputerError(kind: .unknown("usage"), message: "unknown command \(verb)")))
            }
        }
    }

    /// Plan §6.1: warm reads' walk, build and total times, the signature's, and what one read costs in calls.
    static func bench(_ reader: AppReader, _ ref: ComputerProtocol.WindowRef, _ space: CoordinateSpace, _ args: Args) {
        let mode = args.options["mode"] == "auto" ? "auto" : "full"
        let options = ["mode": mode, "budget": args.options["budget"] ?? String(ComputerDefaults.ObservationBudget.defaultBytes)]
        func once() -> (Observed, Double)? {
            let start = ContinuousClock.now
            guard let o = try? observe(reader, ref, space, options: options, flags: []) else { return nil }
            return (o, ms(since: start))
        }
        guard let (first, firstMs) = once() else { fail("the first read failed") }
        for _ in 1..<max(1, args.int("warm", 2)) { _ = once() }
        var walk: [Double] = [], build: [Double] = [], total: [Double] = []
        var last = first
        for _ in 0..<args.int("reads", 20) {
            guard let (o, t) = once() else { continue }
            walk.append(o.walkMs)
            build.append(o.buildMs)
            total.append(t)
            last = o
        }
        var sig: [Double] = []
        for _ in 0..<args.int("signature", 50) {
            let start = ContinuousClock.now
            _ = reader.changes.signature()
            sig.append(ms(since: start))
        }
        let w = reader.lastWalk
        struct Out: Encodable {
            var window: String; var mode: String; var chromium: Bool?; var firstMs: Double; var reads: Int
            var walkMs: Spread; var buildMs: Spread; var totalMs: Spread; var signatureMs: Spread
            var nodes: Int; var calls: Int; var attributes: Int; var stageC: Int; var callsPerNode: Double
            var kept: Int; var bytes: Int; var omitted: Int; var partial: Bool
        }
        emit(Out(window: last.window.title, mode: mode, chromium: first.chromium, firstMs: (firstMs * 100).rounded() / 100, reads: total.count,
                 walkMs: Spread(walk), buildMs: Spread(build), totalMs: Spread(total), signatureMs: Spread(sig),
                 nodes: w.nodes, calls: w.calls, attributes: w.attributes, stageC: w.stageC,
                 callsPerNode: w.nodes > 0 ? (Double(w.calls) / Double(w.nodes) * 100).rounded() / 100 : 0,
                 kept: last.stats.elements, bytes: last.stats.bytes, omitted: last.stats.omitted, partial: last.stats.partial))
    }
}
#endif
