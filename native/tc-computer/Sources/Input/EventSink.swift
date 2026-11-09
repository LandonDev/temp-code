import CoreGraphics
import Foundation

/// Posts Input's events: to the app's pid with the window fields (process), or at the HID
/// tap (session). The source has its own private state, so the person's held modifiers stay
/// out of our events and ours out of theirs.
public final class LiveEventSink: EventSink, @unchecked Sendable {
    private let source = CGEventSource(stateID: .privateState)

    public init() {}

    public func post(_ event: SyntheticEvent, route: EventRoute) {
        switch route {
        case .pid(let pid, let windowID):
            EventMaker.make(event, windowID: windowID, source: source)?.postToPid(pid)
        case .hid:
            EventMaker.make(event, windowID: nil, source: source)?.post(tap: .cghidEventTap)
        }
    }
}
