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

        // rungs 1 and 2: AX insert, AX value
        if chosen == .ax, let dest, let via = try AXTier.insert(dest, text, index: target.element?.index) {
            return InputOutcome(tier: .ax, via: via, clipboard: nil, cursor: target.cursor, lastInputAt: clock.ticks())
        }
        let eventTiers = tiers.filter { $0 == .process || $0 == .session }
        guard let tier = held ?? eventTiers.first, tiers.contains(tier) else {
            throw ComputerFailure(ComputerError(kind: .needsTier, message: "type needs the process tier here, which is not allowed now.", needed: held ?? .process))
        }

        // rung 3: keys
        if TypingRoute.route(text) == .keys {
            let (effect, change, last) = try keys(text, tier: tier, target: target, dest: dest)
            if !TypingRoute.pasteAfterKeys(effect) {
                return InputOutcome(tier: tier, via: .keys, clipboard: nil, cursor: target.cursor, session: change, lastInputAt: last)
            }
        }
        // rung 4: paste, plain text
        return try paste(PasteContent(plain: text), tier: tier, target: target)
    }

    /// Unicode key events into the destination, with the evidence before and after.
    private func keys(_ text: String, tier: Tier, target: InputTarget, dest: AXUIElement?) throws -> (StepEffect, SessionChange?, UInt64?) {
        let pid = target.pid
        if tier == .process {
            if let e = target.element { try ProcessTier.confirmFocus(e, pid: pid, clock: clock) }
            try ProcessTier.requireKeyWindow(pid: pid, window: target.window)
        }
        var effect: StepEffect = .unknown
        let (_, change, last) = try core.step(tier: tier, pid: pid, windowID: target.windowID, window: target.window, keys: true, cancelled: target.cancelled) { ctx in
            if tier == .session, let e = target.element { try ProcessTier.confirmFocus(e, pid: pid, clock: clock) }
            let before = evidence(dest)
            try core.typeKeys(&ctx, text)
            effect = self.effect(of: dest, since: before, within: InputTiming.keysEffectMs, cancelled: target.cancelled)
        }
        return (effect, change, last)
    }

    /// The paste flow: at the session tier inside its step (activation first), at the process
    /// tier posted to the pid, the destination and the key window checked before the clipboard
    /// is touched and again before Command-V.
    func paste(_ content: PasteContent, tier: Tier, target: InputTarget) throws -> InputOutcome {
        let pid = target.pid
        let flow = PasteFlow(store: pasteboard, lock: clipboardLock, clock: clock)
        var focusedAtCheck: AXUIElement?
        let checks: () throws -> Void = { [self] in
            if let e = target.element { try ProcessTier.confirmFocus(e, pid: pid, clock: clock) }
            if tier == .process {
                try ProcessTier.requireKeyWindow(pid: pid, window: target.window)
            } else if !host.isFocusedWindow(target.window, pid: pid) {
                throw sessionUnavailable(.activationRefused, "The window lost keyboard focus before the paste.")
            }
            focusedAtCheck = AX.element(AX.app(pid), "AXFocusedUIElement")
        }
        let recheck: () throws -> Void = { [self] in
            if tier == .process { try ProcessTier.requireKeyWindow(pid: pid, window: target.window) }
            else if !host.isFocusedWindow(target.window, pid: pid) { throw sessionUnavailable(.activationRefused, "The window lost keyboard focus before the paste.") }
            guard ProcessTier.focusStill(focusedAtCheck, pid: pid) else {
                throw ComputerFailure(ComputerError(kind: .actionUnsupported, message: "Keyboard focus moved before the paste; nothing was pasted.", element: target.element?.index))
            }
        }
        let dest = { target.element?.element ?? focusedAtCheck }
        var outcome: ClipboardOutcome = .restored
        let (_, change, last) = try core.step(tier: tier, pid: pid, windowID: target.windowID, window: target.window, keys: true, cancelled: target.cancelled) { ctx in
            (outcome, _) = try flow.run(content, cancelled: target.cancelled, checks: checks, recheck: recheck, post: { try core.commandV(&ctx) }, evidence: { evidence(dest()) })
        }
        return InputOutcome(tier: tier, via: .paste, clipboard: outcome, cursor: target.cursor, session: change, lastInputAt: last)
    }
}
