import Foundation

/// What a socket has told its host about the thread on screen, the
/// desktop's `FocusSignal` (lib/tcserver/commands.ts): `session.focus`
/// names the thread the phone shows while the app is active, and null once
/// it is not. Each value is sent once; a new socket has heard nothing, so
/// after a reconnect the thread on screen is named again. A key below
/// operate sends nothing (the host would refuse it).
public struct FocusSignal: Sendable, Equatable {
    /// The last value sent on this socket: `.none` before the first.
    public private(set) var sent: String??

    public init() {}

    /// The value to send for `visible`, nil when there is nothing to say:
    /// the host already has it, the key may not send it, or nothing was ever
    /// named and nothing is now.
    public mutating func want(_ visible: String?, canSend: Bool) -> String?? {
        guard canSend else { return nil }
        if case .some(let last) = sent, last == visible { return nil }
        if sent == nil, visible == nil { return nil }
        sent = .some(visible)
        return .some(visible)
    }

    /// The socket closed or reopened: the host has forgotten.
    public mutating func reconnected() {
        sent = nil
    }
}
