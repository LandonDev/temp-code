import AppKit
import ApplicationServices
import ComputerCore
import ComputerProtocol
import Foundation
import Input

/// The background fallbacks' hand-run legs (docs/computer-protocol.md §24.9): each route tried at `ax`
/// alone on a scratch window whose app stays in the background, and what happened recorded for §14.8's
/// table: the route, whether the window changed (a signature of its tree), and whether the app came
/// forward, which a fallback must never make it do. A refusal is a finding too (a disabled item's
/// needs_tier, a window that is not key), recorded as the answer it was.
extension Proof {
    /// What a scratch app is tried with: its menu combos in order (one that closes or replaces the window
    /// last), and whether its paste and caret legs apply.
    struct FallbackPlan {
        var combos: [String]
        var caret = true
        var paste = true
    }

    static let fallbackPlans: [String: FallbackPlan] = [
        // ⌘A and ⌘S are first-responder items, ⌘N and ⌘O the app's, ⌘W closes the scratch document last
        "textedit": FallbackPlan(combos: ["super+a", "super+s", "super+n", "super+o", "super+w"]),
        "chrome": FallbackPlan(combos: ["super+l", "super+t", "super+w"]),
        "tempcode": FallbackPlan(combos: ["super+,"]),
        // ⌘⌫ never: it moves the selection to the Trash
        "finder": FallbackPlan(combos: ["super+n", "super+shift+n"], caret: false, paste: false),
        "intellij": FallbackPlan(combos: ["super+,", "super+shift+a"])
    ]

    /// The window's tree as one number: names and values of every element, so a leg can say changed or none.
    private func signature(_ window: AXUIElement) -> Int {
        var h = Hasher()
        for e in P.walk(window, max: 3_000) {
            h.combine(P.string(e, "AXRole"))
            h.combine(P.names(e))
            h.combine(P.string(e, "AXValue"))
        }
        return h.finalize()
    }

    /// One fallback leg at `ax` alone: what it took, whether the window changed, whether the app stayed back.
    private func measure(_ app: String, _ leg: String, _ action: ComputerAction, _ s: inout Scratch, target: (inout Scratch) -> InputTarget) {
        let window = s.window
        let pid = s.pid
        let before = signature(window)
        let into = target(&s)
        step(app, leg, tiers: [.ax], action, allow: [.needsTier, .actionUnsupported, .keyWindowUnavailable, .clipboardBusy], target: { into }) { out in
            Thread.sleep(forTimeInterval: 0.5)
            let changed = signature(window) != before
            let active = NSRunningApplication(processIdentifier: pid)?.isActive ?? false
            let route = [out.via?.rawValue, out.on].compactMap { $0 }.joined(separator: " ")
            return (!active, "\(route.isEmpty ? "no route" : route) · \(changed ? "changed" : "no change seen") · \(active ? "the app came forward" : "stayed in the background")")
        }
    }

    func fallbacks(_ app: String, _ s: inout Scratch) {
        guard let plan = Self.fallbackPlans[app] else { return }
        let window = s.window
        let all = P.walk(window, max: 3_000)
        let centre = { (e: AXUIElement) -> CGPoint? in P.frame(e).map { CGPoint(x: $0.x + $0.w / 2, y: $0.y + $0.h / 2) } }
        let field = all.first { ["AXTextField", "AXComboBox"].contains(P.string($0, "AXRole") ?? "") && P.settable($0, "AXSelectedTextRange") }
            ?? all.first { P.string($0, "AXRole") == "AXTextArea" }

        // hit: a named button by its point, the route walking up from what is under it
        if let button = all.first(where: { P.string($0, "AXRole") == "AXButton" && !(P.names($0).first ?? "").isEmpty && centre($0) != nil }), let p = centre(button) {
            measure(app, "hit: left_click on button \(P.names(button).first ?? "")", ComputerAction(action: .leftClick, coordinate: s.coordinate(p)), &s) { $0.target() }
        } else { missing(app, "hit", "named button") }
        // a row of a table or outline (Finder's list)
        if let row = all.first(where: { P.string($0, "AXRole") == "AXRow" }), let p = centre(row) {
            measure(app, "hit: left_click on a row", ComputerAction(action: .leftClick, coordinate: s.coordinate(p)), &s) { $0.target() }
        }
        // caret: a click at the text's start
        if plan.caret, let field, let f = P.frame(field) {
            measure(app, "caret: left_click in the text", ComputerAction(action: .leftClick, coordinate: s.coordinate(CGPoint(x: f.x + 6, y: f.y + min(f.h / 2, 10)))), &s) { $0.target() }
        }
        // scroll-bar, else the page actions: the first scroll area's middle
        if let area = all.first(where: { P.string($0, "AXRole") == "AXScrollArea" }), let p = centre(area) {
            measure(app, "scroll-bar: scroll down 3", ComputerAction(action: .scroll, coordinate: s.coordinate(p), scroll_direction: .down, scroll_amount: 3), &s) { $0.target() }
        } else { missing(app, "scroll", "scroll area") }
        // ax-insert: a text paste, ax alone, so it can never reach the person's clipboard
        if plan.paste, let field {
            measure(app, "ax-insert: paste text", ComputerAction(action: .paste, element: 1, text: " pasted"), &s) { $0.target(field) }
        }
        // menu: each combo through its item, the window-closing one last
        for combo in plan.combos {
            measure(app, "menu: key \(combo)", ComputerAction(action: .key, text: combo), &s) { $0.target() }
        }
        if app == "textedit" { saveSheet(&s) }
    }

    /// TextEdit's save sheet by AX after ⌘W's close (§24.7): the name field set, `/` inserted for Go to
    /// Folder, and the sheet dismissed with Delete or Cancel, so nothing is saved.
    private func saveSheet(_ s: inout Scratch) {
        guard let sheet = P.walk(s.window, max: 3_000).first(where: { P.string($0, "AXRole") == "AXSheet" }) else {
            return report.notes.append("textedit: no save sheet after the close: §24.7's sheet leg has nothing to drive")
        }
        let inSheet = P.walk(sheet, max: 2_000)
        guard let name = inSheet.first(where: { P.string($0, "AXRole") == "AXTextField" && P.settable($0, "AXValue") }) else {
            return missing("textedit", "save sheet", "name field")
        }
        measure("textedit", "save sheet: set_value the name", ComputerAction(action: .setValue, element: 1, value: "tc-input-fallback"), &s) { $0.target(name) }
        let before = P.walk(s.window, max: 3_000).count
        measure("textedit", "save sheet: insert / for Go to Folder", ComputerAction(action: .paste, element: 1, text: "/"), &s) { $0.target(name) }
        report.notes.append("textedit: inserting / into the save sheet's name field by AX \(P.walk(s.window, max: 3_000).count != before ? "changed the panel (Go to Folder may have opened)" : "left the panel as it was")")
        for word in ["Delete", "Don't Save", "Cancel"] {
            if let b = P.walk(s.window, max: 3_000).first(where: { P.string($0, "AXRole") == "AXButton" && P.names($0).contains(word.lowercased()) }) {
                measure("textedit", "save sheet: press \(word)", ComputerAction(action: .leftClick, element: 1), &s) { $0.target(b) }
                break
            }
        }
    }
}
