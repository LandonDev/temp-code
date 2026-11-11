import AppKit
import ApplicationServices
import ComputerCore
import ComputerProtocol
import Foundation

/// `type`'s ladder within the allowed tiers (AX insert, AX value, keys, paste) and the paste
/// flow at the process and session tiers.
extension InputEngine {
    /// The destination's evidence: AXValue, AXSelectedTextRange and AXNumberOfCharacters, whichever it exposes.
    func evidence(_ e: AXUIElement?) -> Evidence? {
        guard let e else { return nil }
        return Evidence(value: AX.string(e, "AXValue"), range: AX.range(e), count: AX.int(e, "AXNumberOfCharacters"))
    }

    /// Polls the destination until it changes, for at most `ms`.
    func effect(of e: AXUIElement?, since before: Evidence?, within ms: Int, cancelled: () -> Bool) -> StepEffect {
        guard let before else { return .unknown }
        let until = clock.seconds() + Double(ms) / 1000
        var after = evidence(e) ?? Evidence()
        while Evidence.compare(before: before, after: after) != .changed, clock.seconds() < until, !cancelled() {
            clock.sleep(ms: 10)
            after = evidence(e) ?? Evidence()
        }
        return Evidence.compare(before: before, after: after)
    }

    func type(_ action: ComputerAction, target: InputTarget, tiers: [Tier], chosen: Tier, held: Tier?) throws -> InputOutcome {
        let text = action.text ?? ""
        let pid = target.pid
        let dest = target.element?.element ?? AX.element(AX.app(pid), "AXFocusedUIElement")
        if let dest { AX.setTimeout(dest, seconds: InputTiming.axTimeoutS) }

        // rungs 1 and 2: AX insert, AX value; an accepted write that changed nothing goes on to keys,
        // or to needs_tier when no event tier is allowed
        if chosen == .ax, let dest {
            let before = evidence(dest)
            if let via = try AXTier.insert(dest, text, index: target.element?.index) {
                let at = clock.ticks()
                let effect = text.isEmpty ? .unknown : self.effect(of: dest, since: before, within: InputTiming.keysEffectMs, cancelled: target.cancelled)
                if !TypingRoute.nextRungAfterAX(effect) {
                    return InputOutcome(tier: .ax, via: via, clipboard: nil, cursor: target.cursor, lastInputAt: at)
                }
            }
        }
        // the route's own tier (Sol S5): an AX rung that did not finish falls through to the next route
        // the plan chose, so `front` keys run inside their hold and `session` keys through its driver
        if chosen == .ax, held == nil { throw RouteFellThrough() }
        let tier = held ?? chosen
        guard tiers.contains(tier) else {
            throw ComputerFailure(ComputerError(kind: .needsTier, message: "type needs the \(tier.rawValue) tier here, which is not allowed now.", needed: tier))
        }

        // rung 3: keys; rung 4: paste, plain text; inside a session step the focus is checked again after activation (§25.9)
        let recheck = { try self.checkFocus(action, target: target) }
        switch try core.typeByEvents(text, keys: { try keys(text, tier: tier, target: target, dest: dest, recheck: recheck) }, paste: {
            let (r, change, last) = try pasteStep(PasteContent(plain: text), tier: tier, target: target, insertFirst: false, recheck: recheck)
            return (r.clipboard ?? .restored, change, last)
        }) {
        case .keys(let change, let last):
            return InputOutcome(tier: tier, via: .keys, clipboard: nil, cursor: target.cursor, session: change, lastInputAt: last)
        case .paste(let outcome, let change, let last):
            return InputOutcome(tier: tier, via: .paste, clipboard: outcome, cursor: target.cursor, session: change, lastInputAt: last)
        }
    }

    /// Unicode key events into the destination, with the evidence before and after.
    private func keys(_ text: String, tier: Tier, target: InputTarget, dest: AXUIElement?, recheck: () throws -> Void) throws -> (StepEffect, SessionChange?, UInt64?) {
        let pid = target.pid
        if tier == .process {
            if let e = target.element { try ProcessTier.confirmFocus(e, pid: pid, clock: clock) }
            try ProcessTier.requireKeyWindow(pid: pid, window: target.window)
        }
        var effect: StepEffect = .unknown
        let (_, change, last) = try core.step(tier: tier, pid: pid, windowID: target.windowID, window: target.window, keys: true, call: target.sessionCall, cancelled: target.cancelled) { ctx in
            let activated = tier == .session || tier == .front
            if activated, let e = target.element { try ProcessTier.confirmFocus(e, pid: pid, clock: clock) }
            if activated, target.element == nil { try recheck() }
            // activation may move focus: the evidence is read where the keys go, the app's focused element now
            let into = activated && target.element == nil ? AX.element(AX.app(pid), "AXFocusedUIElement") : dest
            let before = evidence(into)
            try core.typeKeys(&ctx, text)
            effect = self.effect(of: into, since: before, within: InputTiming.keysEffectMs, cancelled: target.cancelled)
        }
        return (effect, change, last)
    }

    /// The paste flow: at the session tier inside its step (activation first), at the process
    /// tier posted to the pid, the destination and the key window checked before the clipboard
    /// is touched and again before Command-V. With `insertFirst`, the AX insert of the plain text
    /// is its first rung (§24.6): one that changed the destination never touches the clipboard.
    func paste(_ content: PasteContent, tier: Tier, target: InputTarget, insertFirst: Bool = false, recheck: @escaping () throws -> Void = {}) throws -> InputOutcome {
        let held = HoldReport()
        let (r, change, last) = try pasteStep(content, tier: tier, target: target, insertFirst: insertFirst, recheck: recheck, hold: held)
        if r.via == .axInsert {
            // nothing posted: at the process tier the insert was AX alone; the session tier activated first
            return InputOutcome(tier: tier == .session ? .session : .ax, via: .axInsert, clipboard: nil, cursor: target.cursor, session: change, lastInputAt: last ?? clock.ticks())
        }
        return InputOutcome(tier: tier, via: .paste, clipboard: r.clipboard, cursor: target.cursor, session: change, lastInputAt: last).with(front: held.report)
    }

    /// The `ax-insert` route alone (no event tier allowed): the destination's evidence, nil when it takes no insert.
    func insertOnly(_ text: String, target: InputTarget) throws -> StepEffect? {
        let dest = target.element?.element ?? AX.element(AX.app(target.pid), "AXFocusedUIElement")
        guard let dest else { return nil }
        AX.setTimeout(dest, seconds: InputTiming.axTimeoutS)
        if let e = target.element { try ProcessTier.confirmFocus(e, pid: target.pid, clock: clock) }
        let before = evidence(dest)
        guard AXTier.insertPlain(dest, text) else { return nil }
        return text.isEmpty ? .unknown : effect(of: dest, since: before, within: InputTiming.keysEffectMs, cancelled: target.cancelled)
    }

    private func pasteStep(_ content: PasteContent, tier: Tier, target: InputTarget, insertFirst: Bool, recheck focusRecheck: @escaping () throws -> Void = {}, hold held: HoldReport = HoldReport()) throws -> (PasteResult, SessionChange?, UInt64?) {
        let pid = target.pid
        let flow = PasteFlow(store: pasteboard, lock: clipboardLock, clock: clock, recentForeignCopy: recentForeignCopy)
        var focusedAtCheck: AXUIElement?
        // §24.6: Command-V goes in as the app's Paste item when it is enabled; a disabled one refuses before the write
        var pasteItem: (AXUIElement, MenuMatch)?
        let checks: () throws -> Void = { [self] in
            if let e = target.element { try ProcessTier.confirmFocus(e, pid: pid, clock: clock) }
            // §25.9: after the session step's activation, before the clipboard is touched
            if tier == .session, target.element == nil { try focusRecheck() }
            if tier == .process {
                try ProcessTier.requireKeyWindow(pid: pid, window: target.window)
            } else if tier != .front, !host.isFocusedWindow(target.window, pid: pid) {
                throw sessionUnavailable(.activationRefused, "The window lost keyboard focus before the paste.")
            }
            focusedAtCheck = AX.element(AX.app(pid), "AXFocusedUIElement")
            pasteItem = menuItem(KeyCombo(modifiers: .command, key: .character("v")), pid: pid)
            // at `front` the hold re-validates a Paste the background disables: read again inside it
            if tier != .front, let (_, m) = pasteItem, !m.enabled {
                if tier == .process, NSRunningApplication(processIdentifier: pid)?.isActive != true {
                    throw needsFrontForMenu(m.path, pid: pid)
                }
                throw ComputerFailure(ComputerError(kind: .actionUnsupported, message: "\(m.line) is disabled.", menu: m.path))
            }
        }
        let recheck: () throws -> Void = { [self] in
            if tier == .process { try ProcessTier.requireKeyWindow(pid: pid, window: target.window) }
            else if !host.isFocusedWindow(target.window, pid: pid) { throw sessionUnavailable(.activationRefused, "The window lost keyboard focus before the paste.") }
            guard ProcessTier.focusStill(focusedAtCheck, pid: pid) else {
                throw ComputerFailure(ComputerError(kind: .actionUnsupported, message: "Keyboard focus moved before the paste; nothing was pasted.", element: target.element?.index))
            }
        }
        let pressPaste: () throws -> Bool = { [self] in
            guard let (item, m) = pasteItem else { return false }
            if tier == .front {
                // inside the hold: the item once active, else Command-V to the pid
                guard enabledSoon(item, stop: { held.stopped() }) else { return false }
                try held.check()
            } else if !m.enabled {
                return false
            }
            try AXTier.pressMenu(item, match: m, count: 1)
            return true
        }
        let insert: (() throws -> StepEffect?)? = insertFirst ? { [self] in try insertOnly(content.plain, target: target) } : nil
        let dest = { target.element?.element ?? focusedAtCheck }
        // §26.3, decision 3: at `front` the lock, the snapshot and the write go before the hold and the
        // person's pasteboard back after it; inside it only the recheck, the press and the value wait
        let app = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "The app"
        let inside: ((_ part: (_ stopped: () -> Bool) throws -> Void) throws -> Void)? = tier != .front ? nil : { [self] part in
            let (_, report) = try frontTier.hold(pid: pid, window: target.window, app: app, cancelled: target.cancelled, changedSince: target.changedSince, keepOpen: target.keepFrontOpen) { ctx in
                held.context = ctx
                defer { held.context = nil }
                try part { ctx.cancelled() }
            }
            held.report = report
        }
        return try core.paste(content, flow: flow, quietMs: target.pasteQuietMs, tier: tier, pid: pid, windowID: target.windowID, window: target.window, call: target.sessionCall,
                              cancelled: { [called = target.cancelled] in called() || held.stopped() }, insert: insert, pressPaste: pressPaste, checks: checks, recheck: recheck, evidence: { evidence(dest()) }, inside: inside)
    }

    /// A menu item's AXEnabled read again for a moment once the app is active; false when it stays off.
    private func enabledSoon(_ item: AXUIElement, stop: () -> Bool) -> Bool {
        let until = clock.seconds() + Double(InputTiming.frontSettleMs) / 1000
        while AX.bool(item, "AXEnabled") != true {
            if stop() || clock.seconds() >= until { return false }
            clock.sleep(ms: InputTiming.frontPollMs)
        }
        return true
    }

    /// `needs_tier { needed: 'front', menu }`: a disabled item in an inactive app, which only activation
    /// re-validates (§24.2, §26.3); the host offers `front`, then `session`.
    func needsFrontForMenu(_ path: [String], pid: pid_t) -> ComputerFailure {
        let app = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "the app"
        return ComputerFailure(ComputerError(kind: .needsTier, message: "\(path.joined(separator: " › ")) is disabled while \(app) is in the background.", needed: .front, menu: path))
    }
}


/// A paste's hold, seen from its flow: the context while the hold runs, its report once done.
final class HoldReport: @unchecked Sendable {
    private let lock = NSLock()
    private var _context: FrontHoldContext?
    private var _report: FrontHold?
    var context: FrontHoldContext? {
        get { lock.withLock { _context } }
        set { lock.withLock { _context = newValue } }
    }
    var report: FrontHold? {
        get { lock.withLock { _report } }
        set { lock.withLock { _report = newValue } }
    }
    /// the hold's cap or the person's touch stopped it
    func stopped() -> Bool { context.map { $0.stopped != nil } ?? false }
    func check() throws { try context?.check() }
}
