import AppKit
import ApplicationServices
import ComputerCore
import ComputerProtocol
import CoreGraphics
import Foundation
import Input

/// The proof's legs (plan §9 "Live"): every ax and process leg on the scratch TextEdit,
/// Chrome and TempCode windows, the probe beside the legs that did the same, and the session
/// leg, gated on the person: only after 2 minutes with no input of theirs, checked before
/// every step, else "skipped: the person is active".
final class Proof: @unchecked Sendable {
    let report = Report()
    let gate = IdleGate(needed: 120)
    private(set) var engine: InputEngine!
    private var interrupted: [pid_t] = []

    init() {
        engine = InputEngine(
            clipboardLock: FlockLock("clipboard.lock"),
            sessionLock: FlockLock("session.lock"),
            onPersonInput: { [weak self] pid in self?.interrupted.append(pid) },
            onHeld: { _ in }
        )
    }

    // MARK: one step

    /// A tier 1 or 2 step: it must leave the frontmost app and the pointer where they were.
    /// A step during which the person moved is void and run again, at most 3 times.
    func step(_ app: String, _ leg: String, tiers: [Tier], _ action: ComputerAction, allow: Set<ComputerErrorKind> = [], target: () -> InputTarget, verify: (InputOutcome) -> (Bool, String)) {
        var retries = 0
        while true {
            let before = MacState.now()
            let t0 = Date()
            var r = LegResult(app: app, leg: leg, tiers: tiers.map(\.rawValue), ok: false, detail: "", ms: 0)
            do {
                let out = try engine.perform(action, on: target(), tiers: tiers)
                r.ms = Date().timeIntervalSince(t0) * 1000
                r.tier = out.tier?.rawValue
                r.via = out.via?.rawValue
                r.clipboard = out.clipboard?.rawValue
                Thread.sleep(forTimeInterval: 0.2)
                (r.ok, r.detail) = verify(out)
            } catch let f as ComputerFailure {
                r.ms = Date().timeIntervalSince(t0) * 1000
                r.error = "\(f.error.kind.rawValue): \(f.error.message)"
                if allow.contains(f.error.kind) { r.ok = true; r.detail = "answered \(f.error.kind.rawValue), as this app may" }
            } catch {
                r.error = "\(error)"
            }
            let after = MacState.now()
            r.frontmostMoved = before.frontmost != after.frontmost
            r.pointerMoved = hypot(before.pointer.x - after.pointer.x, before.pointer.y - after.pointer.y) > 0.5
            let personMoved = hidIdle() < Date().timeIntervalSince(t0)
            if r.frontmostMoved || r.pointerMoved {
                if personMoved, retries < 3 { retries += 1; continue }
                r.ok = false
                r.detail += "; it moved the person's \(r.frontmostMoved ? "frontmost app" : "pointer")"
            }
            r.retries = retries
            report.legs.append(r)
            print("\(r.ok ? "ok  " : "FAIL") \(app) \(leg) · \(r.tier ?? "-")\(r.via.map { " \($0)" } ?? "") · \(r.detail)\(r.error.map { " · \($0)" } ?? "")")
            return
        }
    }

    func missing(_ app: String, _ leg: String, _ what: String) {
        report.legs.append(LegResult(app: app, leg: leg, tiers: [], ok: false, detail: "no \(what) in the scratch window", ms: 0))
        print("FAIL \(app) \(leg) · no \(what)")
    }

    // MARK: the pasteboard's safety net

    struct Board: Equatable { let items: [[String: Data]] }

    func board() -> Board {
        Board(items: (NSPasteboard.general.pasteboardItems ?? []).map { item in
            Dictionary(uniqueKeysWithValues: item.types.compactMap { t in item.data(forType: t).map { (t.rawValue, $0) } })
        })
    }

    // MARK: TextEdit

    /// The probe document: the run's marker (cleanup finds the scratch autosaves by it), then 200 numbered lines.
    /// The marker is the first line and the last, so text a leg types into one leaves the other whole.
    static let marker = ProcessInfo.processInfo.environment["TC_INPUT_PROOF_MARKER"] ?? "tc-input-proof"
    static let document = ([marker] + (1 ... 200).map { String(format: "line %03d", $0) } + [marker]).joined(separator: "\n")

    func textEdit(_ s: inout Scratch, tiers: [Tier]) {
        guard let text = s.find("AXTextArea") else { return missing("textedit", "setup", "text area") }
        let value = { P.string(text, "AXValue") ?? "" }
        // the text view is as tall as the document; its scroll area is what shows on screen
        let area = P.element(text, "AXParent")
        let bar = area.flatMap { P.element($0, "AXVerticalScrollBar") }
        if tiers.contains(.ax) {
            step("textedit", "set_value the probe document", tiers: [.ax], ComputerAction(action: .setValue, element: 1, value: Self.document), target: { s.target(text) }) { _ in
                (value() == Self.document, "\(value().utf16.count) units")
            }
            for place in [Placement.select, .before, .after] {
                step("textedit", "select_text 050 after \"line \" (\(place.rawValue))", tiers: [.ax], ComputerAction(action: .selectText, element: 1, text: "050", prefix: "line ", suffix: "\n", place: place), target: { s.target(text) }) { _ in
                    let start = (Self.document as NSString).range(of: "line 050").location + 5
                    let want = place == .select ? [start, 3] : place == .before ? [start, 0] : [start + 3, 0]
                    return (P.range(text) == want, "range \(P.range(text) ?? []) want \(want)")
                }
            }
            step("textedit", "type by AX insert", tiers: [.ax], ComputerAction(action: .type, element: 1, text: "Z"), target: { s.target(text) }) { out in
                (out.via == .axInsert && value().contains("line 050Z"), "via \(out.via?.rawValue ?? "-")")
            }
            if let bold = P.walk(s.window).first(where: { P.names($0).contains("bold") }) {
                let before = P.number(bold, "AXValue")
                step("textedit", "left_click bold", tiers: [.ax], ComputerAction(action: .leftClick, element: 1), target: { s.target(bold) }) { out in
                    (out.tier == .ax && P.number(bold, "AXValue") != before, "value \(before ?? -1) → \(P.number(bold, "AXValue") ?? -1)")
                }
            } else { missing("textedit", "left_click bold", "bold control") }
            if let bar { _ = P.set(bar, "AXValue", NSNumber(value: 0)) }
            let barBefore = bar.flatMap { P.number($0, "AXValue") }
            step("textedit", "scroll down by AX pages", tiers: [.ax], ComputerAction(action: .scroll, element: 1, scroll_direction: .down, scroll_amount: 5), target: { s.target(text) }) { out in
                let now = bar.flatMap { P.number($0, "AXValue") }
                return (out.tier == .ax && (now ?? 0) > (barBefore ?? 0), "scroll bar \(barBefore ?? -1) → \(now ?? -1)")
            }
            if let size = P.walk(s.window).first(where: { ["AXComboBox", "AXPopUpButton"].contains(P.string($0, "AXRole") ?? "") && P.names($0).contains { $0.contains("size") } }) {
                step("textedit", "perform show menu on font size", tiers: [.ax], ComputerAction(action: .perform, element: 1, name: "show menu"), target: { s.target(size) }) { out in
                    (out.tier == .ax, "shown")
                }
                step("textedit", "perform cancel closes it", tiers: [.ax], ComputerAction(action: .perform, element: 1, name: "cancel"), allow: [.actionUnsupported], target: { s.target(size) }) { _ in
                    (true, "closed")
                }
            } else { missing("textedit", "perform show menu", "font size control") }
        }
        guard tiers.contains(.process) else { return }
        let key = AXUIElementCopyFocusedWindowIs(s.app, s.window)
        report.notes.append("textedit: the scratch window \(key ? "is" : "is not") key in its app while in the background")
        if let b = P.bounds(text, 30, 1) {
            step("textedit", "left_click at a character", tiers: [.process], ComputerAction(action: .leftClick, coordinate: s.coordinate(CGPoint(x: b.x + b.w * 0.25, y: b.y + b.h / 2))), target: { s.target() }) { _ in
                (P.range(text)?.first == 30, "caret \(P.range(text) ?? [])")
            }
        } else { missing("textedit", "left_click at a character", "character bounds") }
        let caret = P.range(text)?.first ?? 0
        step("textedit", "key Right", tiers: [.process], ComputerAction(action: .key, text: "Right"), allow: [.keyWindowUnavailable], target: { s.target() }) { _ in
            (P.range(text)?.first == caret + 1, "caret \(caret) → \(P.range(text)?.first ?? -1)")
        }
        step("textedit", "key super+a", tiers: [.process], ComputerAction(action: .key, text: "super+a"), allow: [.keyWindowUnavailable], target: { s.target() }) { _ in
            (P.range(text)?[1] == value().utf16.count, "range \(P.range(text) ?? [])")
        }
        _ = P.set(text, "AXSelectedTextRange", rangeValue(0, 0))
        let fifty = String(repeating: "abcde", count: 10)
        step("textedit", "type 50 characters by keys", tiers: [.process], ComputerAction(action: .type, element: 1, text: fifty), allow: [.keyWindowUnavailable], target: { s.target(text) }) { out in
            (out.via == .keys && value().contains(fifty), "via \(out.via?.rawValue ?? "-")")
        }
        if let bar, let f = area.flatMap({ P.frame($0) }) {
            _ = P.set(bar, "AXValue", NSNumber(value: 0))
            let v0 = P.number(bar, "AXValue") ?? 0
            step("textedit", "scroll 3 wheel clicks down", tiers: [.process], ComputerAction(action: .scroll, coordinate: s.coordinate(CGPoint(x: f.x + f.w / 2, y: f.y + f.h / 2)), scroll_direction: .down, scroll_amount: 3), target: { s.target() }) { _ in
                let v1 = P.number(bar, "AXValue") ?? 0
                return (v1 > v0, "scroll bar \(v0) → \(v1)")
            }
            _ = P.set(bar, "AXValue", NSNumber(value: 0))
        }
        if let a = P.bounds(text, 12, 1), let b = P.bounds(text, 20, 1) {
            step("textedit", "drag selects text", tiers: [.process], ComputerAction(action: .leftClickDrag, coordinate: s.coordinate(CGPoint(x: b.x + 1, y: b.y + b.h / 2)), start_coordinate: s.coordinate(CGPoint(x: a.x + 1, y: a.y + a.h / 2))), target: { s.target() }) { _ in
                ((P.range(text)?[1] ?? 0) > 0, "range \(P.range(text) ?? [])")
            }
        }
        if let w = P.bounds(text, 1, 1) {
            step("textedit", "double_click selects a word", tiers: [.process], ComputerAction(action: .doubleClick, coordinate: s.coordinate(CGPoint(x: w.x + w.w / 2, y: w.y + w.h / 2))), target: { s.target() }) { _ in
                ((P.range(text)?[1] ?? 0) >= 4, "range \(P.range(text) ?? [])")
            }
            step("textedit", "right_click opens a menu", tiers: [.process], ComputerAction(action: .rightClick, coordinate: s.coordinate(CGPoint(x: w.x + w.w / 2, y: w.y + w.h / 2))), target: { s.target() }) { _ in
                let open = P.walk(s.app, max: 400).contains { P.string($0, "AXRole") == "AXMenu" }
                return (open, open ? "a menu is open" : "no menu")
            }
            step("textedit", "key Escape closes it", tiers: [.process], ComputerAction(action: .key, text: "Escape"), allow: [.keyWindowUnavailable], target: { s.target() }) { _ in
                let open = P.walk(s.app, max: 400).contains { P.string($0, "AXRole") == "AXMenu" }
                return (!open, open ? "the menu stayed" : "closed")
            }
            // a menu left open would swallow the legs after it: close it through AX, whatever the leg said
            for menu in P.walk(s.app, max: 400) where P.string(menu, "AXRole") == "AXMenu" {
                _ = AXUIElementPerformAction(menu, "AXCancel" as CFString)
            }
        }
        let saved = board()

        for (format, textIn, shows) in [(PasteFormat.markdown, "# Heading\n\n**Bold** and *it*", "Bold and it"), (.html, "<p>Pasted <b>HTML</b></p>", "Pasted HTML"), (.text, "plain pasted", "plain pasted")] {
            _ = P.set(text, "AXSelectedTextRange", rangeValue(0, 0))
            step("textedit", "paste \(format.rawValue)", tiers: [.process], ComputerAction(action: .paste, element: 1, text: textIn, format: format), allow: [.keyWindowUnavailable], target: { s.target(text) }) { out in
                let restored = self.board() == saved
                return (value().contains(shows) && restored && out.clipboard == .restored, "shows \(value().contains(shows)), clipboard \(out.clipboard?.rawValue ?? "-"), byte for byte \(restored)")
            }
        }
        // no net of the proof's own: it cannot tell a person's copy from a paste's leftover, and the clipboard is the person's
        if board() != saved { report.notes.append("textedit: the clipboard differs from the run's start (a paste's leftover, or the person's copy): left as it is") }
    }

    // MARK: Chrome

    func chrome(_ s: inout Scratch, tiers: [Tier]) {
        let window = s.window
        let byId = { (id: String) in P.walk(window).first { P.string($0, "AXDOMIdentifier") == id } }
        guard let name = byId("name"), let gift = byId("gift") else { return missing("chrome", "setup", "form fields") }
        if tiers.contains(.ax) {
            step("chrome", "set_value the name", tiers: [.ax], ComputerAction(action: .setValue, element: 1, value: "Ada Example"), target: { s.target(name) }) { _ in
                (P.string(name, "AXValue") == "Ada Example", "value \(P.string(name, "AXValue") ?? "-")")
            }
            let g0 = P.number(gift, "AXValue")
            step("chrome", "left_click the checkbox", tiers: [.ax], ComputerAction(action: .leftClick, element: 1), target: { s.target(gift) }) { out in
                (out.tier == .ax && P.number(gift, "AXValue") != g0, "checked \(g0 ?? -1) → \(P.number(gift, "AXValue") ?? -1)")
            }
            if let confirm = byId("confirm") {
                step("chrome", "left_click the dialog button", tiers: [.ax], ComputerAction(action: .leftClick, element: 1), target: { s.target(confirm) }) { out in
                    let dialog = P.walk(s.window).contains { P.names($0).contains("review order") && P.string($0, "AXRole") != "AXButton" }
                    return (out.tier == .ax && dialog, dialog ? "the dialog is open" : "no dialog")
                }
                if let cancel = P.walk(s.window).first(where: { P.string($0, "AXRole") == "AXButton" && P.names($0).contains("cancel") }) {
                    _ = AXUIElementPerformAction(cancel, "AXPress" as CFString)
                }
            }
            step("chrome", "select_text in the name", tiers: [.ax], ComputerAction(action: .selectText, element: 1, text: "Example"), target: { s.target(name) }) { _ in
                (P.range(name) == [4, 7], "range \(P.range(name) ?? [])")
            }
        }
        guard tiers.contains(.process) else { return }
        report.notes.append("chrome: the scratch window \(AXUIElementCopyFocusedWindowIs(s.app, s.window) ? "is" : "is not") key in its app while in the background")
        if let notes = byId("notes"), let f = P.frame(notes) {
            step("chrome", "left_click into the notes", tiers: [.process], ComputerAction(action: .leftClick, coordinate: s.coordinate(CGPoint(x: f.x + f.w / 2, y: f.y + f.h / 2))), target: { s.target() }) { _ in
                (P.element(s.app, "AXFocusedUIElement").map { CFEqual($0, notes) } == true, "focused")
            }
            step("chrome", "type into the notes", tiers: [.process], ComputerAction(action: .type, element: 1, text: "hello"), allow: [.keyWindowUnavailable], target: { s.target(notes) }) { out in
                ((P.string(notes, "AXValue") ?? "").contains("hello"), "via \(out.via?.rawValue ?? "-")")
            }
        }
        if let f = P.frame(gift) {
            let g0 = P.number(gift, "AXValue")
            step("chrome", "left_click the checkbox", tiers: [.process], ComputerAction(action: .leftClick, coordinate: s.coordinate(CGPoint(x: f.x + f.w / 2, y: f.y + f.h / 2))), target: { s.target() }) { _ in
                (P.number(gift, "AXValue") != g0, "checked \(g0 ?? -1) → \(P.number(gift, "AXValue") ?? -1)")
            }
        }
        if let rows = byId("rows"), let f = P.frame(rows), let area = P.walk(s.window).first(where: { P.string($0, "AXRole") == "AXWebArea" }) {
            let y0 = P.frame(rows)?.y ?? 0
            step("chrome", "scroll the 60-row list", tiers: [.process], ComputerAction(action: .scroll, coordinate: s.coordinate(CGPoint(x: f.x + 20, y: min(f.y + 20, (P.frame(area)?.y ?? 0) + (P.frame(area)?.h ?? 0) - 20))), scroll_direction: .down, scroll_amount: 5), target: { s.target() }) { _ in
                let y1 = P.frame(rows)?.y ?? 0
                return (y1 < y0, "list top \(y0) → \(y1)")
            }
        }
        if let a = P.bounds(name, 0, 1), let b = P.bounds(name, 3, 1) {
            // the ax leg left a selection in the name; the drag must make its own
            _ = P.set(name, "AXSelectedTextRange", rangeValue(0, 0))
            step("chrome", "drag selects in the name (the page has no slider)", tiers: [.process], ComputerAction(action: .leftClickDrag, coordinate: s.coordinate(CGPoint(x: b.x + b.w, y: b.y + b.h / 2)), start_coordinate: s.coordinate(CGPoint(x: a.x + 1, y: a.y + a.h / 2))), target: { s.target() }) { _ in
                ((P.range(name)?[1] ?? 0) > 0, "range \(P.range(name) ?? [])")
            }
        }
    }

    // MARK: TempCode

    func tempcode(_ s: inout Scratch, tiers: [Tier]) {
        guard let composer = s.find("AXTextArea") else { return missing("tempcode", "setup", "composer") }
        if tiers.contains(.ax) {
            step("tempcode", "type into the composer", tiers: [.ax], ComputerAction(action: .type, element: 1, text: "from the input proof"), allow: [.needsTier], target: { s.target(composer) }) { out in
                ((P.string(composer, "AXValue") ?? "").contains("from the input proof"), "via \(out.via?.rawValue ?? "-")")
            }
            if let button = P.walk(s.window).first(where: { P.string($0, "AXRole") == "AXButton" && P.actions($0).contains("AXPress") && !(P.names($0).first ?? "").isEmpty }) {
                step("tempcode", "left_click a toolbar button", tiers: [.ax], ComputerAction(action: .leftClick, element: 1), target: { s.target(button) }) { out in
                    (out.tier == .ax, "pressed \(P.names(button).first ?? "")")
                }
            }
        }
        guard tiers.contains(.process), let f = P.frame(composer) else { return }
        report.notes.append("tempcode: the scratch window \(AXUIElementCopyFocusedWindowIs(s.app, s.window) ? "is" : "is not") key in its app while in the background")
        step("tempcode", "left_click into the composer", tiers: [.process], ComputerAction(action: .leftClick, coordinate: s.coordinate(CGPoint(x: f.x + 20, y: f.y + f.h / 2))), target: { s.target() }) { _ in
            (true, "clicked")
        }
        step("tempcode", "type into the composer", tiers: [.process], ComputerAction(action: .type, text: " typed"), allow: [.keyWindowUnavailable], target: { s.target() }) { out in
            ((P.string(composer, "AXValue") ?? "").contains("typed"), "via \(out.via?.rawValue ?? "-")")
        }
    }

    // MARK: the probe

    func probe(_ app: String, _ s: inout Scratch) {
        do {
            let r = try engine.probe(s.target(), classes: [.scroll, .key, .click])
            var results: [String: String] = [:]
            for x in r.results { results[x.class.rawValue] = x.outcome.rawValue + (x.reason.map { " (\($0))" } ?? "") }
            let total = r.results.reduce(0) { $0 + $1.ms }
            report.probes.append(ProbeLine(app: app, keyWindow: r.keyWindow.rawValue, results: results, restored: r.results.allSatisfy(\.restored), ms: total))
            print("probe \(app) · key window \(r.keyWindow.rawValue) · \(results)")
        } catch {
            report.notes.append("\(app): the probe failed: \(error)")
        }
    }

    /// The probe beside the direct legs that did the same: a disagreement between two tested ones fails the proof.
    func compareProbes() {
        let direct: [String: (String) -> Bool] = [
            "scroll": { $0.contains("scroll 3 wheel clicks") || $0.contains("scroll the 60-row list") },
            "key": { $0 == "key Right" || $0 == "type into the notes" || $0 == "type into the composer" },
            "click": { $0 == "left_click at a character" || $0 == "left_click into the notes" || $0 == "left_click into the composer" }
        ]
        for p in report.probes {
            for (cls, outcome) in p.results where !outcome.hasPrefix("untested") {
                guard let leg = report.legs.first(where: { $0.app == p.app && $0.tiers == ["process"] && direct[cls]!($0.leg) && $0.error?.hasPrefix("key_window_unavailable") != true }) else { continue }
                let agree = outcome.hasPrefix("honoured") == leg.ok
                if !agree {
                    report.legs.append(LegResult(app: p.app, leg: "probe \(cls) agrees with \"\(leg.leg)\"", tiers: ["process"], ok: false, detail: "probe \(outcome), leg \(leg.ok ? "worked" : "failed")", ms: 0))
                }
            }
            if !p.restored { report.legs.append(LegResult(app: p.app, leg: "probe put everything back", tiers: ["process"], ok: false, detail: "a value stayed changed", ms: 0)) }
        }
    }

    // MARK: the session leg

    /// One session step, only while the person has been quiet 2 minutes; nil when it ran, else the skip reason.
    func sessionStep(_ leg: String, _ action: ComputerAction, target: () -> InputTarget, verify: (InputOutcome) -> (Bool, String)) -> Bool {
        guard gate.stillQuiet() else {
            report.legs.append(LegResult(app: "session", leg: leg, tiers: ["session"], ok: true, detail: "", ms: 0, skipped: "skipped: the person is active"))
            print("skip session \(leg) · the person is active")
            return false
        }
        gate.stepStarted()
        let t0 = Date()
        var r = LegResult(app: "session", leg: leg, tiers: ["session"], ok: false, detail: "", ms: 0)
        // the step's own input ends when the engine returns; anything after it, the check's wait included, is the person's
        let resolved = target()
        let perform = { () throws -> InputOutcome in
            defer { self.gate.stepEnded() }
            return try self.engine.perform(action, on: resolved, tiers: [.session])
        }
        do {
            let out = try perform()
            r.ms = Date().timeIntervalSince(t0) * 1000
            r.tier = out.tier?.rawValue
            r.via = out.via?.rawValue
            if let c = out.session { r.session = "front \(c.frontmost.before?.name ?? "-") → \(c.frontmost.after?.name ?? "-"), pointer \(c.pointer.before) → \(c.pointer.after)" }
            Thread.sleep(forTimeInterval: 0.2)
            (r.ok, r.detail) = verify(out)
            r.ok = r.ok && out.tier == .session && out.session != nil
        } catch let f as ComputerFailure {
            r.error = "\(f.error.kind.rawValue): \(f.error.message)"
            if f.error.kind == .interrupted {
                // the person is back: the leg stops here and takes nothing more
                gate.personActive()
                r.ok = true
                r.skipped = "skipped: the person is active"
                report.legs.append(r)
                print("skip session \(leg) · the person took over")
                return false
            }
        } catch {
            r.error = "\(error)"
        }
        report.legs.append(r)
        print("\(r.ok ? "ok  " : "FAIL") session \(leg) · \(r.session ?? "") \(r.error ?? "")")
        return true
    }

    func session(textEdit te: inout Scratch, chrome ch: inout Scratch?) {
        print("session leg: waiting for 2 minutes with no input from the person (at most 10)")
        guard gate.waitQuiet(maxWait: 600) else {
            report.legs.append(LegResult(app: "session", leg: "the session leg", tiers: ["session"], ok: true, detail: "", ms: 0, skipped: "skipped: the person is active"))
            print("skip session leg · the Mac was in use for 10 minutes")
            return
        }
        gate.watchPerson()
        defer { gate.stopWatching() }
        guard let text = te.find("AXTextArea"), let b = P.bounds(text, 5, 1) else { return missing("session", "setup", "TextEdit text") }
        let at = te.coordinate(CGPoint(x: b.x + 1, y: b.y + b.h / 2))
        guard sessionStep("left_click into TextEdit", ComputerAction(action: .leftClick, coordinate: at), target: { te.target() }, verify: { _ in (P.range(text) != nil, "caret \(P.range(text) ?? [])") }),
              sessionStep("type \"session\"", ComputerAction(action: .type, text: "session"), target: { te.target() }, verify: { out in ((P.string(text, "AXValue") ?? "").contains("session"), "via \(out.via?.rawValue ?? "-")") }),
              sessionStep("key super+a", ComputerAction(action: .key, text: "super+a"), target: { te.target() }, verify: { _ in ((P.range(text)?[1] ?? 0) > 100, "range \(P.range(text) ?? [])") })
        else { return giveBack() }
        if var c = ch, let gift = P.walk(c.window).first(where: { P.string($0, "AXDOMIdentifier") == "gift" }), let f = P.frame(gift) {
            let g0 = P.number(gift, "AXValue")
            guard sessionStep("left_click Chrome's checkbox", ComputerAction(action: .leftClick, coordinate: c.coordinate(CGPoint(x: f.x + f.w / 2, y: f.y + f.h / 2))), target: { c.target() }, verify: { _ in (P.number(gift, "AXValue") != g0, "checked \(g0 ?? -1) → \(P.number(gift, "AXValue") ?? -1)") }) else { return giveBack() }
            ch = c
        }
        guard gate.stillQuiet() else { return giveBack() }
        do {
            let r = try engine.restoreSession()
            let ok = r.frontmost == .restored && r.pointer == .restored
            report.legs.append(LegResult(app: "session", leg: "restoreSession gives back the app and the pointer", tiers: ["session"], ok: ok, detail: "frontmost \(r.frontmost.rawValue), pointer \(r.pointer.rawValue), held \(r.held?.name ?? "-")", ms: 0))
            print("\(ok ? "ok  " : "FAIL") session restore · \(r.frontmost.rawValue) \(r.pointer.rawValue)")
        } catch {
            report.legs.append(LegResult(app: "session", leg: "restoreSession", tiers: ["session"], ok: false, detail: "", ms: 0, error: "\(error)"))
        }
        guard gate.stillQuiet() else { return giveBack() }
        // a 5 s hold of shift, and 300 ms in an unmarked move from another source, as the person's.
        // That stand-in is the proof's own: the leg's watch is set aside for it, and from the step's
        // end the HID idle time alone says whether the person came (giveBack's stillQuiet).
        gate.stopWatching()
        gate.stepStarted()
        let person = DispatchQueue(label: "proof.person")
        let posted = Box<Date?>(nil)
        person.asyncAfter(deadline: .now() + 0.3) {
            let src = CGEventSource(stateID: .hidSystemState)
            CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: CGEvent(source: nil)?.location ?? .zero, mouseButton: .left)?.post(tap: .cghidEventTap)
            posted.value = Date()
        }
        var r = LegResult(app: "session", leg: "hold_key shift stops at the person's move", tiers: ["session"], ok: false, detail: "", ms: 0)
        do {
            _ = try engine.perform(ComputerAction(action: .holdKey, text: "shift", duration: 5), on: te.target(), tiers: [.session])
            r.detail = "the hold ran its 5 s"
        } catch let f as ComputerFailure where f.error.kind == .interrupted {
            let after = posted.value.map { Date().timeIntervalSince($0) * 1000 } ?? -1
            gate.stepEnded()
            // the up is posted before the throw; the window server's key state follows it a little later
            let t = Date()
            var released = false
            repeat {
                released = !CGEventSource.keyState(.combinedSessionState, key: 56)
                if !released { Thread.sleep(forTimeInterval: 0.005) }
            } while !released && Date().timeIntervalSince(t) < 0.1
            let lag = Int(Date().timeIntervalSince(t) * 1000)
            r.ok = after >= 0 && after < 100 && released
            r.detail = "interrupted \(Int(after)) ms after the move; shift \(released ? "released (state \(lag) ms after the throw)" : "still down 100 ms after the throw")"
        } catch {
            r.error = "\(error)"
        }
        gate.stepEnded()
        report.legs.append(r)
        print("\(r.ok ? "ok  " : "FAIL") session hold_key · \(r.detail)")
        giveBack()
    }

    /// Puts back what the session leg took, whatever stopped it.
    func giveBack() {
        if !gate.stillQuiet() {
            report.notes.append("session leg: nothing put back: the person is active")
            return
        }
        if let r = try? engine.restoreSession() { report.notes.append("session leg: restore at the end: frontmost \(r.frontmost.rawValue), pointer \(r.pointer.rawValue)") }
    }
}

final class Box<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: T
    init(_ v: T) { _value = v }
    var value: T {
        get { lock.withLock { _value } }
        set { lock.withLock { _value = newValue } }
    }
}

func rangeValue(_ location: Int, _ length: Int) -> AXValue {
    var r = CFRange(location: location, length: length)
    return AXValueCreate(.cfRange, &r)!
}

/// Whether the app's AXFocusedWindow is this window.
func AXUIElementCopyFocusedWindowIs(_ app: AXUIElement, _ window: AXUIElement) -> Bool {
    P.element(app, "AXFocusedWindow").map { CFEqual($0, window) } ?? false
}
