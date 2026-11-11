import ApplicationServices
import ComputerCore
import ComputerProtocol
import struct ComputerProtocol.WindowRef
import ComputerServiceKit
import Foundation
import Input

/// Input, handed to a worker closure.
struct InputBox: @unchecked Sendable {
    let input: any InputPerforming
}

/// What one step left for the waits that follow it.
private struct StepRun {
    var step: StepResult
    /// `t0`: the step's last input, for the wait after it; nil when it posted none
    var t0: UInt64?
    var signature0: UInt64 = 0
    /// the step's effect as Input read it itself (§25.7: a web toggle's value read back); it stands in for the wait's
    var inputEffect: StepEffect?
    /// the commit check begun before the step acted (§26.8), judged after its wait
    var check: CommitCheck?
    /// the step failed or was cancelled
    var stops: Bool { if case .ok = step { return false } else { return true } }

    /// the wait's verdict, unless Input read the step's effect itself
    func effect(_ waited: StepEffect) -> StepEffect { inputEffect ?? waited }
}

private struct Performed: Sendable {
    let outcome: InputOutcome
    let signature0: UInt64
    var check: CommitCheck?
    let element: ElementBrief?
    let returnedAt: UInt64
}

/// The call a step is in, for Input's person guard: its token, the host's person idle at its start; and its
/// §25.9 facts: the process is Chromium, the expected focus (an epoch-checked index) and the call's actions,
/// by which `FocusCheck.bindsExpectation` names the one step the expectation binds.
struct StepCall: Sendable {
    let token: Int?
    let personIdleMs: Int?
    var chromium = false
    var expectFocus: Int?
    var actions: [ComputerAction] = []

    /// The index the step at `index` expects focused: the call's `expectFocus` on the step it binds alone.
    func expectation(at index: Int) -> Int? {
        guard let expectFocus, FocusCheck.bindsExpectation(step: index, of: actions) else { return nil }
        return expectFocus
    }
}

extension ComputerService {
    func registerActions() {
        // a cancelled action answers its normal result, the stopped step failed (spec §1)
        router.on("action.run", keepsResult: true) { [self] (p: Methods.ActionRun.Params, ctx) -> ActionResult in
            let result = try await runActions(
                session: p.session, app: p.app, window: p.window, launch: p.launch ?? false, epoch: p.epoch,
                actions: [p.action], tiers: p.tiers, stepWait: nil, wait: p.wait, observe: p.observe, pasteQuietMs: p.pasteQuietMs, personIdleMs: p.personIdleMs, ignored: p.ignored,
                tabs: p.tabs, expectFocus: p.expectFocus, ctx: ctx
            )
            return features.fit(ActionResult(
                step: result.steps[0], observation: result.observation, observationError: result.observationError, front: result.front,
                menusLeftOpen: result.menusLeftOpen
            ))
        }
        router.on("action.batch", keepsResult: true) { [self] (p: Methods.ActionBatch.Params, ctx) in
            features.fit(try await runActions(
                session: p.session, app: p.app, window: p.window, launch: p.launch ?? false, epoch: p.epoch,
                actions: p.actions, tiers: p.tiers, stepWait: p.stepWait, wait: p.wait, observe: p.observe, pasteQuietMs: p.pasteQuietMs, personIdleMs: p.personIdleMs, ignored: p.ignored,
                tabs: p.tabs, expectFocus: p.expectFocus, ctx: ctx
            ))
        }
    }

    /// One or more actions on one app (shell §9.1): the steps in order, the `step` wait between those that can
    /// change the screen, a stop at the first failure, the `action` wait once after the last step that ran,
    /// one observation. `pasteQuietMs` goes to Input with every step: a paste refuses a copy that recent.
    /// `personIdleMs` too: the person guard gives typing back only after a call whose person was that recent (§14.9.4).
    /// The whole call runs under the front guard (§23.4), its report on the result. `tabs` and `expectFocus`
    /// are §25.4's and §25.9's: a ref naming a background tab selects it under the call's exclusive slot, and
    /// the expected focus binds the step `FocusCheck.bindsExpectation` names.
    func runActions(
        session: String, app: AppRef, window: WindowRef?, launch: Bool, epoch callEpoch: String?, actions: [ComputerAction],
        tiers: [Tier], stepWait: WaitOptions?, wait: WaitOptions?, observe: ObserveOptions?, pasteQuietMs: Int? = nil, personIdleMs: Int? = nil, ignored: IgnoredRoutes? = nil,
        tabs: TabsMode? = nil, expectFocus: Int? = nil, ctx: RequestContext
    ) async throws -> BatchResult {
        let guarded = FrontRun(front, actions: actions, tiers: tiers, tail: env.timing.frontActionTail)
        do {
            let result = try await runActions(
                session: session, app: app, window: window, launch: launch, epoch: callEpoch, actions: actions, tiers: tiers,
                stepWait: stepWait, wait: wait, observe: observe, pasteQuietMs: pasteQuietMs, personIdleMs: personIdleMs, ignored: ignored,
                tabs: tabs, expectFocus: expectFocus, ctx: ctx, front: guarded
            )
            return result.with(front: guarded.answered(result, cancelled: ctx.cancel.isSet))
        } catch {
            _ = guarded.answered(nil, cancelled: ctx.cancel.isSet)
            throw error
        }
    }

    private func runActions(
        session: String, app: AppRef, window: WindowRef?, launch: Bool, epoch callEpoch: String?, actions: [ComputerAction],
        tiers: [Tier], stepWait: WaitOptions?, wait: WaitOptions?, observe: ObserveOptions?, pasteQuietMs: Int?, personIdleMs: Int?, ignored: IgnoredRoutes?,
        tabs: TabsMode?, expectFocus: Int?, ctx: RequestContext, front: FrontRun
    ) async throws -> BatchResult {
        // every index the call names, `expectFocus` with them, against the call's epoch (§4.2, §25.9)
        if let failure = CallIndexes.check(actions, expectFocus: expectFocus, epoch: callEpoch, current: epoch) { throw failure }
        let target = try await resolveTarget(session: session, app: app, window: window, launch: launch, ctx: ctx)
        front.watch(target)
        // a click this call makes is carried for a stream that starts until clickCarryMs after its answer
        ctx.afterAnswer { [self] in clickCallAnswered(ctx.id) }

        guard let lease = await slots.slot(target.pid).acquire(.exclusive(session: session), timeout: env.timing.appSlotWait) else {
            if ctx.cancel.isSet { await releaseHeld(session: session) }
            let error = ctx.cancel.isSet
                ? Router.cancelledError
                : ComputerError(kind: .appBusy, message: "\(target.app.name) is busy with another session's action; try again.")
            return BatchResult(
                steps: notRun(actions, from: 1, first: .failed(FailedStep(index: 0, action: actions[0].action, error: error))),
                observationError: error, waited: WaitRule.skipped().report
            )
        }
        defer { lease.release() }
        // §25.4: a ref naming a background tab selects it now, under this call's exclusive slot, which it holds
        // through the steps and the observation; `tab_in_use` and a selection that did not take are request errors
        var selection: TabSelection?
        if TabPlan.decide(.act, tabSelected: target.tab?.selected).select {
            selection = try await selectTab(target, tabs: tabs, waitMs: (wait ?? ComputerDefaults.Wait.action).busyMaxMs)
        }
        let chromium = await isChromium(target)
        // a call that may use the session tier is bracketed before any step, so a trip anywhere in it
        // finds its session and marks it (§14.9.5)
        var call = StepCall(token: tiers.contains(.session) ? input.callBegan(pid: target.pid) : nil, personIdleMs: personIdleMs)
        call.chromium = chromium
        call.expectFocus = expectFocus
        call.actions = actions
        if let token = call.token {
            book.noteSessionStep(session: session, pid: target.pid)
            book.beginCall(token: token, session: session, pid: target.pid)
        }
        defer {
            if let token = call.token {
                input.callEnded(token)
                book.endCall(token: token)
            }
        }

        var steps: [StepResult] = []
        var openHold: Int?
        var last: StepRun?
        var lastAction: ComputerAction?
        for (index, action) in actions.enumerated() {
            if ctx.cancel.isSet {
                steps += notRun(actions, from: index + 1, first: .failed(FailedStep(index: index, action: action.action, error: Router.cancelledError)))
                break
            }
            let next = index + 1 < actions.count ? actions[index + 1] : nil
            var run = await step(index, action, target: target, tiers: tiers, maxEdge: observe?.maxEdge, pasteQuietMs: pasteQuietMs, call: call, ignored: ignored, next: next, ctx: ctx)
            let isLast = index == actions.count - 1
            if !run.stops && !isLast, let t0 = run.t0, case .ok(let ok) = run.step {
                let waited = await waitAfter(target, options: stepWait ?? ComputerDefaults.Wait.step, t0: t0, signature0: run.signature0, pasteboard: WaitRule.readsPasteboard(action), cancel: ctx.cancel)
                var judged = ok.with(effect: run.effect(waited.effect(thin: book.lastThin(session, pid: target.pid))), waited: waited.report)
                if let check = run.check, !ctx.cancel.isSet { judged = await committed(judged, check, target) }
                run.step = .ok(judged)
            }
            steps.append(run.step)
            // decision 4: a step that left its hold open, and a hold closed since, reported on the step that last used it
            await takeFrontReport(target, into: &steps, at: &openHold)
            // a front step with no report left its hold open; one with a report closed it (a joined hold included)
            if case .ok(let ok) = run.step, ok.tier == .front { openHold = ok.front == nil ? index : nil }
            last = run
            lastAction = action
            if run.stops {
                steps += notRun(actions, from: index + 1)
                break
            }
        }

        // a hold still open (the batch stopped early) closes before the action wait, which runs in the background
        if openHold != nil {
            await closeFrontHold(target)
            await takeFrontReport(target, into: &steps, at: &openHold)
        }

        // the action wait, once, after the last step that ran; a target window the step closed is a change (§22.6)
        var waited = WaitRule.skipped()
        var windowGone = false
        if let last, let t0 = last.t0, !ctx.cancel.isSet {
            waited = await waitAfter(target, options: wait ?? ComputerDefaults.Wait.action, t0: t0, signature0: last.signature0, pasteboard: lastAction.map(WaitRule.readsPasteboard) ?? false, cancel: ctx.cancel)
            if waited.report.reason != .cancelled, !waited.appLeft {
                // an app that quit just after the wait ended counts as one that quit during it
                windowGone = inventory.isRunning(target.pid) ? await windowClosed(target) : true
            }
            if let at = steps.indices.last, case .ok(let ok) = steps[at] {
                let effect = waited.effect(thin: book.lastThin(session, pid: target.pid), windowGone: windowGone)
                var judged = ok.with(effect: last.effect(effect), waited: waited.report)
                if let check = last.check, !windowGone, waited.report.reason != .cancelled { judged = await committed(judged, check, target) }
                steps[at] = .ok(judged)
            }
        }
        front.closing()

        // a cancel takes no observation; a step already done keeps its result
        if ctx.cancel.isSet || waited.report.reason == .cancelled {
            await releaseHeld(session: session)
            return BatchResult(steps: steps, observationError: Router.cancelledError, waited: waited.report)
        }

        if observe?.mode == ObserveMode.none {
            return BatchResult(steps: steps, waited: waited.report)
        }
        do {
            guard inventory.isRunning(target.pid) else {
                throw ComputerError(kind: .windowNotFound, message: "\(target.app.name) quit.", reason: .gone)
            }
            // the target closed: the app's window as §2.1 picks it with none named, read whole (§22.6)
            var knobs = ObserveKnobs(observe)
            if windowGone { knobs.mode = .full }
            knobs.closingMenus = true
            let shown = windowGone ? try await windowAfterClose(target) : target
            let switched = selection.flatMap { TabPlan.selectedTab(switched: $0.switched, title: $0.title) }
            let frontAllowed = tiers.contains(.front)
            let observation: Observation
            do {
                observation = try await self.observe(shown, knobs, loading: waited.report.busy, waited: waited.report, selectedTab: windowGone ? nil : switched, cancel: ctx.cancel)
            } catch let error where ComputerService.failure(error, or: .windowNotFound).kind == .timeout {
                // an app that stopped answering may sit in a menu of its own: close it, read once more (§26.11)
                guard await closeStuckMenu(shown, frontAllowed: frontAllowed) else { throw error }
                observation = try await self.observe(shown, knobs, loading: waited.report.busy, waited: waited.report, selectedTab: windowGone ? nil : switched, cancel: ctx.cancel)
            }
            let leftOpen = await closeMenus(shown, frontAllowed: frontAllowed)
            return BatchResult(steps: steps, observation: observation, waited: waited.report, menusLeftOpen: leftOpen)
        } catch {
            if ctx.cancel.isSet { await releaseHeld(session: session) }
            return BatchResult(steps: steps, observationError: ComputerService.failure(error, or: .windowNotFound), waited: waited.report)
        }
    }

    /// One step: the shell's own pictures and wait, or Input.
    private func step(_ index: Int, _ action: ComputerAction, target: Resolved, tiers: [Tier], maxEdge: Int?, pasteQuietMs: Int?, call: StepCall, ignored: IgnoredRoutes?, next: ComputerAction?, ctx: RequestContext) async -> StepRun {
        let thin = book.lastThin(target.session, pid: target.pid)
        switch action.action {
        case .screenshot, .zoom:
            do {
                let shot = try await takeShot(
                    target, maxEdge: maxEdge ?? ComputerDefaults.Shot.defaultMaxEdge, region: action.action == .zoom ? action.region : nil,
                    format: nil, action: action.action.rawValue
                )
                if action.action == .screenshot {
                    book.setSpace(target.session, window: target.windowID, CoordinateSpace(width: shot.width, height: shot.height, scale: shot.scale))
                }
                let skipped = WaitRule.skipped()
                return StepRun(step: .ok(OkStep(index: index, action: action.action, tier: nil, effect: skipped.effect(thin: false), shot: shot, waited: skipped.report)))
            } catch {
                return StepRun(step: failed(index, action, error, or: .captureFailed))
            }
        case .wait:
            let t0 = MachTime.now()
            let options = ComputerDefaults.Wait.waitAction(seconds: action.duration ?? 0)
            do {
                let sig0 = try await signature(target)
                let pixel = await pixelWatch(target)
                let waited = await SmartWait.run(
                    options, from: t0, signature0: sig0, thin: thin, watch: try await waitWatch(target, pixel: pixel), cancel: ctx.cancel,
                    isRunning: { [inventory] in inventory.isRunning($0) }, tick: env.timing.waitTick, trace: trace
                )
                if waited.report.reason == .cancelled { return StepRun(step: failed(index, action, Router.cancelledError, or: .cancelled)) }
                return StepRun(step: .ok(OkStep(index: index, action: .wait, tier: nil, effect: waited.effect(thin: thin), waited: waited.report)))
            } catch {
                return StepRun(step: failed(index, action, error, or: .windowNotFound))
            }
        default:
            return await perform(index, action, target: target, tiers: tiers, pasteQuietMs: pasteQuietMs, call: call, ignored: ignored, next: next, ctx: ctx)
        }
    }

    /// Everything else, `cursor_position` included, goes to Input (shell §9.1 step 4).
    private func perform(_ index: Int, _ action: ComputerAction, target: Resolved, tiers: [Tier], pasteQuietMs: Int?, call: StepCall, ignored: IgnoredRoutes?, next: ComputerAction?, ctx: RequestContext) async -> StepRun {
        let pixel = await pixelWatch(target)
        let keepAlive = keepWatchAlive(target, while: pixel != nil)
        defer { keepAlive?.cancel() }

        let cursor = book.cursor(target.session, pid: target.pid)
        let space = book.space(target.session, window: target.windowID)
            ?? capture.space(windowID: target.windowID, frame: target.info.frame, maxEdge: ComputerDefaults.Shot.defaultMaxEdge)
        let box = InputBox(input: input)
        let flag = ctx.cancel
        let info = target.info
        let pid = target.pid
        let windowID = target.windowID
        let expected = call.expectation(at: index)
        // the commit check only for a host that reads it, never for the cursor read, and never on web content:
        // a Chromium window has no file behind it, so nothing there is expected to commit (§25, §26.8)
        let checks = features.commit && action.action != .cursorPosition && !call.chromium
        if action.action == .saveAs, call.chromium {
            // §26.7 saves a document window's file; a page is no document of the app's
            let error = ComputerError(kind: .actionUnsupported, message: "save_as saves a document window's file; \(target.app.name) shows web content, which has none.")
            return StepRun(step: .failed(FailedStep(index: index, action: .saveAs, error: error)))
        }
        let readDocument = documentReader
        // §26.11: an item of a pop-up, menu button or context menu this session's last call closed
        if let index = action.element, MenuCloser.pressesItem(action) {
            do {
                if let on = try await reachClosedItem(target, index: index) {
                    let ok = OkStep(index: index, action: action.action, tier: .ax, effect: WaitRule.skipped().effect(thin: false),
                                    input: OkStep.Input(via: .menu, on: on))
                    return StepRun(step: .ok(ok), t0: MachTime.now(), signature0: (try? await signature(target)) ?? 0)
                }
            } catch {
                return StepRun(step: failed(index, action, error, or: .staleElement))
            }
        }
        do {
            let done = try await target.worker.run { state -> Performed in
                guard let reader = state.reader, let window = state.windows[windowID] else {
                    throw ComputerError(kind: .windowNotFound, message: "The window is gone.")
                }
                let element = try action.element.map { try reader.resolve($0) }
                let start = try action.start_element.map { try reader.resolve($0) }
                // §25.9: the focus the model's latest read showed, on the one step it binds; gone is `stale_element`
                let expectFocus = try expected.map { try reader.resolve($0) }
                var inputTarget = InputTarget(
                    pid: pid, windowID: windowID, windowFrame: info.frame, window: window, space: space,
                    element: element, startElement: start, cursor: cursor, cancelled: { flag.isSet }, pasteQuietMs: pasteQuietMs, ignored: ignored,
                    callToken: call.token, personIdleMs: call.personIdleMs,
                    chromium: call.chromium, expectFocus: expectFocus, briefOf: { [reader] in reader.brief(of: $0) }
                )
                // decision 4: another step follows, so a `front` step may leave its hold open for it
                inputTarget.keepFrontOpen = next != nil
                // a front hold's settle: the app's tree changed after its last input (§26.2)
                let changes = ChangeBox(signal: reader.changes)
                inputTarget.changedSince = { changes.signal.lastChange > $0 }
                var check: CommitCheck?
                if checks {
                    let context = CommitContext(action: action, element: element.map(CommitElement.of), menuPath: element.flatMap { InputEngine.menuItemPath($0.element) }, next: next)
                    check = CommitCheck.begin(context, state: readDocument(window))
                    if let expects = check?.expectsBefore { inputTarget.commitExpected = { _ in expects } }
                }
                let sig0 = reader.changes.signature()
                let outcome = try box.input.perform(action, on: inputTarget, tiers: tiers)
                return Performed(outcome: outcome, signature0: sig0, check: check, element: element?.brief, returnedAt: MachTime.now())
            }
            let outcome = done.outcome
            if let cursor = outcome.cursor { book.setCursor(target.session, pid: target.pid, cursor) }
            if let at = outcome.clickAt { clicked(at, space: space, session: target.session, windowID: target.windowID, call: ctx.id) }
            if outcome.clipboard == .keptPersonCopy {
                let now = env.system.now()
                lock.withLock { clipboard?.personCopiedDuringPaste(at: now) }
            }
            let isCursor = action.action == .cursorPosition
            let ok = OkStep(
                index: index, action: action.action, tier: isCursor ? nil : outcome.tier,
                effect: outcome.effect ?? WaitRule.skipped().effect(thin: false), element: done.element,
                input: outcome.via.map { OkStep.Input(via: $0, clipboard: outcome.clipboard, on: outcome.on) },
                cursor: outcome.cursor, text: isCursor ? outcome.cursor.map { "X=\($0[0]), Y=\($0[1])" } : nil,
                session: outcome.session, front: outcome.front, disk: outcome.disk
            )
            return StepRun(step: .ok(ok), t0: isCursor ? nil : (outcome.lastInputAt ?? done.returnedAt), signature0: done.signature0, inputEffect: outcome.effect, check: done.check)
        } catch {
            let failure = ComputerService.failure(error, or: .actionUnsupported)
            // once per call, whether this step or the between-calls path tells it first
            if failure.kind == .interrupted, call.token.map(book.markTold) ?? true { interrupted(session: target.session) }
            if failure.kind == .permissionMissing { pokePermissions() }
            return StepRun(step: .failed(FailedStep(index: index, action: action.action, error: failure)))
        }
    }

    /// §25.1: whether the target's process is Chromium, by its bundle (read once per bundle).
    private func isChromium(_ target: Resolved) async -> Bool {
        let source = modules.windows
        let pid = target.pid
        return (try? await target.worker.run { _ in source.chromium(pid: pid) }) ?? false
    }

    /// Whether the target window has left the app's AXWindows (a close; its CG entry may stay a while).
    private func windowClosed(_ target: Resolved) async -> Bool {
        let source = modules.windows
        let pid = target.pid
        let id = target.info.id
        guard let list = try? await target.worker.run({ _ in try source.list(pid: pid) }) else { return false }
        return !list.contains { $0.id == id }
    }

    /// §22.6: after the target closed, the app's window as §2.1 resolves it with no `window`; an app
    /// left with none is `window_not_found` "<App> has no window open.", one whose remaining windows
    /// §2.1 will not pick is the resolver's own refusal with their titles.
    private func windowAfterClose(_ target: Resolved) async throws -> Resolved {
        let source = modules.windows
        let pid = target.pid
        let name = target.app.name.isEmpty ? "The app" : target.app.name
        let info = try await target.worker.run { state -> WindowInfo in
            if try source.list(pid: pid).isEmpty { throw ComputerError(kind: .windowNotFound, message: "\(name) has no window open.", candidates: [], reason: .gone) }
            let (element, info) = try source.resolve(pid: pid, ref: nil)
            state.windows[UInt32(truncatingIfNeeded: info.id)] = element
            return info
        }
        return Resolved(session: target.session, pid: pid, app: target.app, worker: target.worker, info: info, launched: false)
    }

    /// The wait after a step, from its last input. A copy or cut (`pasteboard`) also watches the
    /// pasteboard's foreign changes (§24.10), as milliseconds since t0.
    private func waitAfter(_ target: Resolved, options: WaitOptions, t0: UInt64, signature0: UInt64, pasteboard: Bool = false, cancel: CancelFlag) async -> WaitOutcome {
        let pixel = await pixelWatch(target)
        let keepAlive = keepWatchAlive(target, while: pixel != nil)
        defer { keepAlive?.cancel() }
        guard var watch = try? await waitWatch(target, pixel: pixel) else {
            return WaitRule(options: options, signature0: signature0, thin: false, pixels: false).appGone(at: MachTime.ms(from: t0, to: MachTime.now()))
        }
        if pasteboard {
            let t0Epoch = env.system.now() - Double(MachTime.ms(from: t0, to: MachTime.now()))
            watch.pasteboardChange = { [self] in
                lock.withLock { clipboard?.foreignChangeAt }.flatMap { $0 > t0Epoch ? Int($0 - t0Epoch) : nil }
            }
        }
        return await SmartWait.run(
            options, from: t0, signature0: signature0, thin: book.lastThin(target.session, pid: target.pid), watch: watch, cancel: cancel,
            isRunning: { [inventory] in inventory.isRunning($0) }, tick: env.timing.waitTick, trace: trace
        )
    }

    /// Touches capture's watch every 10 s while a step and its wait run, so no action outlives its watch.
    private func keepWatchAlive(_ target: Resolved, while live: Bool) -> Task<Void, Never>? {
        guard live else { return nil }
        let capture = self.capture
        let windowID = target.windowID
        return Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                if Task.isCancelled { return }
                _ = try? await capture.watch(windowID: windowID)
            }
        }
    }

    /// Lets go of every button and key the session holds (a cancel, `session.close`).
    func releaseHeld(session: String) async {
        let box = InputBox(input: input)
        for (pid, holder) in held.all where holder == session {
            _ = try? await blocking { box.input.releaseHeld(pid: pid) }
        }
    }

    /// Closes a `front` hold the call left open (decision 4), on the app's worker.
    private func closeFrontHold(_ target: Resolved) async {
        let box = InputBox(input: input)
        let pid = target.pid
        _ = try? await target.worker.run { _ in box.input.closeFrontHold(pid: pid) }
    }

    /// A hold closed since the step that last used it returned: its report goes on that step.
    private func takeFrontReport(_ target: Resolved, into steps: inout [StepResult], at index: inout Int?) async {
        guard let at = index, let report = input.takeFrontReport(pid: target.pid) else { return }
        index = nil
        guard steps.indices.contains(at), case .ok(let ok) = steps[at] else { return }
        steps[at] = .ok(OkStep(index: ok.index, action: ok.action, tier: ok.tier, effect: ok.effect, element: ok.element, input: ok.input, cursor: ok.cursor, text: ok.text,
                               shot: ok.shot, waited: ok.waited, session: ok.session, front: report, disk: ok.disk))
    }

    /// The commit check's second read, after the step's wait (§26.8): a step expected to commit with
    /// nothing on disk yet polls every `commitPollMs` for at most `commitSettleMs`.
    private func committed(_ ok: OkStep, _ check: CommitCheck, _ target: Resolved) async -> OkStep {
        if ok.disk?.saved != nil { return ok } // save_as proved its own file
        let windowID = target.windowID
        let read = documentReader
        let now: () async -> DocumentState? = {
            (try? await target.worker.run { state in state.windows[windowID].flatMap(read) }) ?? nil
        }
        var disk = check.diff(await now())
        let deadline = ContinuousClock.now + .milliseconds(ComputerDefaults.Front.commitSettleMs)
        while check.waiting(disk), ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(ComputerDefaults.Front.commitPollMs))
            disk = check.diff(await now())
        }
        let (effect, part) = check.judge(window: ok.effect, disk: disk)
        return OkStep(index: ok.index, action: ok.action, tier: ok.tier, effect: effect, element: ok.element, input: ok.input, cursor: ok.cursor, text: ok.text,
                      shot: ok.shot, waited: ok.waited, session: ok.session, front: ok.front, disk: part)
    }

    private func failed(_ index: Int, _ action: ComputerAction, _ error: any Error, or kind: ComputerErrorKind) -> StepResult {
        .failed(FailedStep(index: index, action: action.action, error: ComputerService.failure(error, or: kind)))
    }

    private func notRun(_ actions: [ComputerAction], from start: Int, first: StepResult? = nil) -> [StepResult] {
        let rest = actions.indices.dropFirst(start).map { StepResult.notRun(NotRunStep(index: $0, action: actions[$0].action)) }
        return (first.map { [$0] } ?? []) + rest
    }
}

extension OkStep {
    /// The same step with the wait's verdict.
    func with(effect: StepEffect, waited: WaitReport) -> OkStep {
        OkStep(index: index, action: action, tier: tier, effect: effect, element: element, input: input, cursor: cursor, text: text, shot: shot, waited: waited, session: session,
               front: front, disk: disk)
    }
}
