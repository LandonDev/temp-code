import ComputerProtocol

/// Every delay and cap Input uses, named (docs/computer-protocol.md "Input: timing").
/// The Task benchmark may tune the numbers; the shapes stay. A number the wire
/// already names (ComputerDefaults) is read from there, so it has one home.
public enum InputTiming {
    /// between posted events
    public static let eventGapMs = 8
    /// a click's down → up
    public static let clickHoldMs = 40
    /// between the pairs of a double or triple click, under the system double-click interval
    public static let multiClickGapMs = 60
    /// after a pointer move, before the down
    public static let moveSettleMs = 30
    public static let dragSteps = 12
    public static let dragMs = 180
    /// between wheel clicks
    public static let scrollGapMs = 15

    /// UTF-16 units per Unicode key event: the event truncates its string past this
    public static let typeChunkUnits = ComputerDefaults.Typing.keyChunkUnits
    public static let typeChunkGapMs = 10
    /// text longer than this goes in by paste, never by keys
    public static let keysMaxUnits = ComputerDefaults.Typing.pasteMinUnits
    /// `keys` with no change seen within this goes on to paste
    public static let keysEffectMs = 300

    /// how long a paste waits for its destination to change
    public static let pasteWaitMs = ComputerDefaults.Typing.pasteSettleMs
    /// the whole paste flow, from the clipboard lock on
    public static let pasteCapMs = ComputerDefaults.Locks.clipboardHoldMaxMs
    public static let clipboardWaitS = Double(ComputerDefaults.Locks.clipboardWaitMs) / 1000

    /// the session tier's activation: polled this often, for at most this long
    public static let activationMs = 400
    public static let activationPollMs = 20
    /// the session lock: tried in slices this long, for at most this long
    public static let sessionLockWaitS = 5.0
    public static let sessionLockTryS = 0.05
    /// a pointer within this many points of where the step left it has not moved
    public static let pointerSlackPt = 2.0

    /// a named destination must become the app's focused element within this
    public static let focusConfirmMs = 200
    /// a pause is slept in slices this long, checking the person and cancel between them
    public static let watchSliceMs = 10
    /// `hold_key` and a click's `duration` sleep in slices this long
    public static let holdSliceMs = 50

    /// a held button or key is let go this long after its down with no up
    public static let heldReleaseS = Double(ComputerDefaults.Service.heldInputReleaseMs) / 1000
    /// `input.restoreSession { afterInterrupt }` skips the person check this long after their trip
    public static let restoreAfterInterruptS = Double(ComputerDefaults.Service.restoreAfterInterruptMs) / 1000
    /// a click's `duration` cap
    public static let maxClickDurationS = Double(ComputerDefaults.ActionLimits.clickDurationMaxSeconds)

    /// every AX element Input calls has this messaging timeout
    public static let axTimeoutS = Double(ComputerDefaults.AXWalk.messagingTimeoutMs) / 1000
    /// work Input hands to the main thread (the person watch, the key layout) must answer within this
    public static let mainHopS = 1.0

    /// the probe: how long a class waits to see its effect
    public static let probeCheckMs = 300
    /// the probe's absolute deadline, from its start
    public static let probeCapMs = 2_000
    /// no class starts past this
    public static let probeLastStartMs = 1_500
    /// the messaging timeout of every element the probe touches, and of each restore write
    public static let probeCallTimeoutS = 0.25
    /// nodes the probe's candidate search reads at most
    public static let probeMaxNodes = 500

    /// the menu route's walk of the bar (§24.2): items read at most, and its time cap
    public static let menuMaxItems = 3_000
    public static let menuMaxMs = 250
    /// a pid's index of key equivalents is read again past this
    public static let menuIndexMaxAgeS = 30.0
    /// the hit route looks at the element under the point and at most this many ancestors (§24.3)
    public static let hitAncestors = 3
    /// the caret route reads its element's focus and range back for at most this long (§24.4)
    public static let caretEvidenceMs = 300

    /// the `front` tier's hold (§25.2): activation polled every `frontPollMs` for at most this long
    public static let frontActivateMaxMs = ComputerDefaults.Front.activateMaxMs
    public static let frontPollMs = ComputerDefaults.Front.pollMs
    /// after the last input, the app stays in front until a change signal or this, at most `frontSettleMaxMs`
    public static let frontSettleMs = ComputerDefaults.Front.settleMs
    public static let frontSettleMaxMs = ComputerDefaults.Front.settleMaxMs
    /// the restore: the person's app back in front within this
    public static let frontRestoreMaxMs = ComputerDefaults.Front.restoreMaxMs
    /// a hold never lasts past this from activation to the restore's start
    public static let frontHoldMaxMs = ComputerDefaults.Front.holdMaxMs
    /// before a hold: the person's last key down this old and nothing held, waited for at most `frontQuietMaxMs`
    public static let frontQuietMs = ComputerDefaults.Front.quietMs
    public static let frontQuietMaxMs = ComputerDefaults.Front.quietMaxMs
    /// a `key` at `front` repeats at most this often; longer `type` text than this goes by paste
    public static let frontKeyRepeatMax = ComputerDefaults.Front.keyRepeatMax
    public static let frontKeysMaxUnits = ComputerDefaults.Front.keysMaxUnits
    /// a save panel must show within this after the press that opens it (§25.7)
    public static let panelOpenMaxMs = ComputerDefaults.Front.panelOpenMaxMs
    /// a step expected to commit polls the disk every `commitPollMs` for at most this (§25.8)
    public static let commitSettleMs = ComputerDefaults.Front.commitSettleMs
    public static let commitPollMs = ComputerDefaults.Front.commitPollMs
}
