import ApplicationServices
import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import Foundation

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
    /// the step failed or was cancelled
    var stops: Bool { if case .ok = step { return false } else { return true } }
}

private struct Performed: Sendable {
    let outcome: InputOutcome
    let signature0: UInt64
    let element: ElementBrief?
    let returnedAt: UInt64
}

extension ComputerService {
    func registerActions() {
        router.on("action.run") { [self] (p: Methods.ActionRun.Params, ctx) -> ActionResult in
            let result = try await runActions(
                session: p.session, app: p.app, window: p.window, launch: p.launch ?? false, epoch: p.epoch,
                actions: [p.action], tiers: p.tiers, stepWait: nil, wait: p.wait, observe: p.observe, ctx: ctx
            )
            return ActionResult(step: result.steps[0], observation: result.observation, observationError: result.observationError)
        }
        router.on("action.batch") { [self] (p: Methods.ActionBatch.Params, ctx) in
            try await runActions(
                session: p.session, app: p.app, window: p.window, launch: p.launch ?? false, epoch: p.epoch,
                actions: p.actions, tiers: p.tiers, stepWait: p.stepWait, wait: p.wait, observe: p.observe, ctx: ctx
            )
        }
    }

    /// One or more actions on one app (shell §9.1): the steps in order, the `step` wait between those that can
    /// change the screen, a stop at the first failure, the `action` wait once after the last step that ran,
    /// one observation.
    func runActions(
        session: String, app: AppRef, window: WindowRef?, launch: Bool, epoch callEpoch: String?, actions: [ComputerAction],
        tiers: [Tier], stepWait: WaitOptions?, wait: WaitOptions?, observe: ObserveOptions?, ctx: RequestContext
    ) async throws -> BatchResult {
        for action in actions {
            for element in [action.element, action.start_element].compactMap({ $0 }) {
                if let failure = EpochCheck.check(names: element, epoch: callEpoch, current: epoch) { throw failure }
            }
        }
        let target = try await resolveTarget(session: session, app: app, window: window, launch: launch)

        guard let lease = await slots.slot(target.pid).acquire(.exclusive(session: session), timeout: env.timing.appSlotWait) else {
            let error = ctx.cancel.isSet
                ? Router.cancelledError
                : ComputerError(kind: .appBusy, message: "\(target.app.name) is busy with another session's action; try again.")
            return BatchResult(
                steps: notRun(actions, from: 1, first: .failed(FailedStep(index: 0, action: actions[0].action, error: error))),
                observationError: error, waited: WaitRule.skipped().report
            )
        }
        defer { lease.release() }

        var steps: [StepResult] = []
        var last: StepRun?
        for (index, action) in actions.enumerated() {
            if ctx.cancel.isSet {
                steps += notRun(actions, from: index + 1, first: .failed(FailedStep(index: index, action: action.action, error: Router.cancelledError)))
                break
            }
            var run = await step(index, action, target: target, tiers: tiers, maxEdge: observe?.maxEdge, ctx: ctx)
            let isLast = index == actions.count - 1
            if !run.stops && !isLast, let t0 = run.t0, case .ok(let ok) = run.step {
                let waited = await waitAfter(target, options: stepWait ?? ComputerDefaults.Wait.step, t0: t0, signature0: run.signature0, cancel: ctx.cancel)
                run.step = .ok(ok.with(effect: waited.effect(thin: book.lastThin(session, pid: target.pid)), waited: waited.report))
            }
            steps.append(run.step)
            last = run
            if run.stops {
                steps += notRun(actions, from: index + 1)
                break
            }
        }

        // the action wait, once, after the last step that ran
        var waited = WaitRule.skipped()
        if let last, let t0 = last.t0, !ctx.cancel.isSet {
            waited = await waitAfter(target, options: wait ?? ComputerDefaults.Wait.action, t0: t0, signature0: last.signature0, cancel: ctx.cancel)
            if let at = steps.indices.last, case .ok(let ok) = steps[at] {
                steps[at] = .ok(ok.with(effect: waited.effect(thin: book.lastThin(session, pid: target.pid)), waited: waited.report))
            }
        }

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
                throw ComputerError(kind: .windowNotFound, message: "\(target.app.name) quit.")
            }
            let observation = try await self.observe(target, ObserveKnobs(observe), loading: waited.report.busy, waited: waited.report, cancel: ctx.cancel)
            return BatchResult(steps: steps, observation: observation, waited: waited.report)
        } catch {
            if ctx.cancel.isSet { await releaseHeld(session: session) }
            return BatchResult(steps: steps, observationError: ComputerService.failure(error, or: .windowNotFound), waited: waited.report)
        }
    }

    /// One step: the shell's own pictures and wait, or Input.
    private func step(_ index: Int, _ action: ComputerAction, target: Resolved, tiers: [Tier], maxEdge: Int?, ctx: RequestContext) async -> StepRun {
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
            return await perform(index, action, target: target, tiers: tiers, ctx: ctx)
        }
    }

    /// Everything else, `cursor_position` included, goes to Input (shell §9.1 step 4).
    private func perform(_ index: Int, _ action: ComputerAction, target: Resolved, tiers: [Tier], ctx: RequestContext) async -> StepRun {
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
        do {
            let done = try await target.worker.run { state -> Performed in
                guard let reader = state.reader, let window = state.windows[windowID] else {
                    throw ComputerError(kind: .windowNotFound, message: "The window is gone.")
                }
                let element = try action.element.map { try reader.resolve($0) }
                let start = try action.start_element.map { try reader.resolve($0) }
                let inputTarget = InputTarget(
                    pid: pid, windowID: windowID, windowFrame: info.frame, window: window, space: space,
                    element: element, startElement: start, cursor: cursor, cancelled: { flag.isSet }
                )
                let sig0 = reader.changes.signature()
                let outcome = try box.input.perform(action, on: inputTarget, tiers: tiers)
                return Performed(outcome: outcome, signature0: sig0, element: element?.brief, returnedAt: MachTime.now())
            }
            let outcome = done.outcome
            if let cursor = outcome.cursor { book.setCursor(target.session, pid: target.pid, cursor) }
            if outcome.clipboard == .keptPersonCopy {
                let now = env.system.now()
                lock.withLock { clipboard?.personCopiedDuringPaste(at: now) }
            }
            let isCursor = action.action == .cursorPosition
            let ok = OkStep(
                index: index, action: action.action, tier: isCursor ? nil : outcome.tier,
                effect: WaitRule.skipped().effect(thin: false), element: done.element,
                input: outcome.via.map { OkStep.Input(via: $0, clipboard: outcome.clipboard) },
                cursor: outcome.cursor, text: isCursor ? outcome.cursor.map { "X=\($0[0]), Y=\($0[1])" } : nil,
                session: outcome.session
            )
            return StepRun(step: .ok(ok), t0: isCursor ? nil : (outcome.lastInputAt ?? done.returnedAt), signature0: done.signature0)
        } catch {
            let failure = ComputerService.failure(error, or: .actionUnsupported)
            if failure.kind == .interrupted { interrupted(session: target.session) }
            if failure.kind == .permissionMissing { pokePermissions() }
            return StepRun(step: .failed(FailedStep(index: index, action: action.action, error: failure)))
        }
    }

    /// The wait after a step, from its last input.
    private func waitAfter(_ target: Resolved, options: WaitOptions, t0: UInt64, signature0: UInt64, cancel: CancelFlag) async -> WaitOutcome {
        let pixel = await pixelWatch(target)
        let keepAlive = keepWatchAlive(target, while: pixel != nil)
        defer { keepAlive?.cancel() }
        guard let watch = try? await waitWatch(target, pixel: pixel) else {
            return WaitRule(options: options, signature0: signature0, thin: false, pixels: false).appGone(at: MachTime.ms(from: t0, to: MachTime.now()))
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
        let input = InputBox(input: self.input)
        for (pid, holder) in held.all where holder == session {
            await Task.detached { input.input.releaseHeld(pid: pid) }.value
        }
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
        OkStep(index: index, action: action, tier: tier, effect: effect, element: element, input: input, cursor: cursor, text: text, shot: shot, waited: waited, session: session)
    }
}
