import ComputerProtocol

/// §27.8, the service's copy of src/shared/computer/batchStop.ts: after a step that sent input and changed nothing, a
/// later key or text step that names no target does not run, nor does any step after it. Both copies are held to one
/// table of cases, src/main/server/computer/fixtures/batch-stop.json.
public enum BatchStop {
    /// The steps that send keys or text.
    public static let keyTextActions: Set<ComputerActionName> = [.type, .paste, .key, .holdKey]
    /// The steps that post no input (protocol.ts `NO_INPUT_ACTIONS`): they never count as the step before.
    public static let noInputActions: Set<ComputerActionName> = [.screenshot, .zoom, .cursorPosition, .wait]

    /// A key or text step that names no target: it goes wherever the focus is.
    public static func typesBlind(_ action: ComputerAction) -> Bool {
        keyTextActions.contains(action.action) && action.element == nil && action.named == nil
    }

    /// Whether the step stops the batch here, given the effect of the last step that ran and sent input
    /// (`unknown`, a thin tree, never stops it).
    public static func stopsHere(lastEffect: StepEffect?, _ action: ComputerAction) -> Bool {
        lastEffect == StepEffect.none && typesBlind(action)
    }

    /// One request's steps as they run: the last input step's effect and index, starting from the call's `prior`.
    public struct Tracker: Sendable, Equatable {
        public private(set) var lastEffect: StepEffect?
        /// this request's index of that step; nil while it is `prior`'s
        public private(set) var lastStep: Int?

        public init(prior: Prior? = nil) {
            lastEffect = prior?.effect
        }

        /// A step that ran: one that sent input becomes the step before.
        public mutating func ran(_ index: Int, _ action: ComputerAction, effect: StepEffect) {
            guard !BatchStop.noInputActions.contains(action.action) else { return }
            lastEffect = effect
            lastStep = index
        }

        /// The stop before `action`, or nil when it runs. A stop that rests on `prior` alone names step 0 of this
        /// request: the wire has no index for a step of an earlier segment (the host checks that boundary itself).
        public func stop(before action: ComputerAction) -> NotRunStep.Stopped? {
            guard BatchStop.stopsHere(lastEffect: lastEffect, action) else { return nil }
            return NotRunStep.Stopped(afterStep: lastStep ?? 0, reason: "no-change")
        }
    }
}
