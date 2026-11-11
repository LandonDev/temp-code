import ComputerProtocol
import Foundation

/// What the host named in `initialize`'s `features` (docs/computer-protocol.md §3; plan decision 14): the
/// service sends a field an older host could not parse only when the host listed its feature. `front`
/// covers the front tier (`tier`, `needed`, `step.front`), `commit` the disk check (the `uncommitted`
/// effect, `step.disk`, the document line), `save_as` the save panel route (`panel`, `not_committed`,
/// `file_exists`). An unknown name is ignored; a host that sent none speaks none.
public struct HostFeatures: Hashable, Sendable {
    public let front: Bool
    public let commit: Bool
    public let saveAs: Bool

    public init(_ listed: [String]?) {
        let names = Set(listed ?? [])
        front = names.contains("front")
        commit = names.contains("commit")
        saveAs = names.contains("save_as")
    }

    /// A host that named every feature this build speaks.
    public static let all = HostFeatures(computerFeatures)
    /// A host from before `features`.
    public static let none = HostFeatures(nil)

    /// Whether the observation may carry the document line.
    public var documentLine: Bool { commit }

    /// The step as this host can read it: a `front` tier reads `session` (the nearest it knows: the app came
    /// forward), `uncommitted` reads `changed` (the window changed), and the fields it never asked for go.
    public func fit(_ step: StepResult) -> StepResult {
        switch step {
        case .ok(let ok):
            if front && commit && saveAs { return step }
            return .ok(OkStep(
                index: ok.index, action: ok.action, tier: fit(ok.tier), effect: !commit && ok.effect == .uncommitted ? .changed : ok.effect,
                element: ok.element, input: !saveAs && ok.input?.via == .panel ? nil : ok.input, cursor: ok.cursor, text: ok.text,
                shot: ok.shot, waited: ok.waited, session: ok.session, front: front ? ok.front : nil, disk: commit ? ok.disk : nil,
                opened: ok.opened, resolved: ok.resolved, focusTo: ok.focusTo
            ))
        case .failed(let failed):
            return .failed(FailedStep(index: failed.index, action: failed.action, error: fit(failed.error)))
        case .notRun, .unknown:
            return step
        }
    }

    /// The error as this host can read it: `needed: front` asks for `session`, which the host's gate knows,
    /// and the save panel's own kinds read `action_unsupported` with their words.
    public func fit(_ error: ComputerError) -> ComputerError {
        let kind: ComputerErrorKind = !saveAs && (error.kind == .notCommitted || error.kind == .fileExists) ? .actionUnsupported : error.kind
        let needed = fit(error.needed)
        if kind == error.kind, needed == error.needed, front || error.front == nil { return error }
        return ComputerError(
            kind: kind, message: error.message, which: error.which, candidates: error.candidates, element: error.element, reason: error.reason,
            available: error.available, needed: needed, coordinate: error.coordinate, space: error.space, by: error.by, keyWindow: error.keyWindow,
            session: error.session, front: front ? error.front : nil, menu: error.menu, value: error.value, focused: error.focused,
            elementCandidates: error.elementCandidates
        )
    }

    public func fit(_ result: BatchResult) -> BatchResult {
        if front && commit && saveAs { return result }
        return BatchResult(
            steps: result.steps.map(fit), observation: result.observation, observationError: result.observationError.map(fit),
            waited: result.waited, front: result.front, menusLeftOpen: result.menusLeftOpen
        )
    }

    public func fit(_ result: ActionResult) -> ActionResult {
        if front && commit && saveAs { return result }
        return ActionResult(
            step: fit(result.step), observation: result.observation, observationError: result.observationError.map(fit),
            front: result.front, menusLeftOpen: result.menusLeftOpen
        )
    }

    private func fit(_ tier: Tier?) -> Tier? { !front && tier == .front ? .session : tier }
}
