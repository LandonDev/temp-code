/// Every event Input posts carries this in `eventSourceUserData` ("tccp"); the person watch
/// takes any input event without it as the person's.
public let TC_EVENT_MARK: Int64 = 0x7463_6370

/// The input event kinds the person watch listens to, by CGEventType raw value.
public enum WatchedEventType: UInt32, CaseIterable, Sendable {
    case leftMouseDown = 1
    case rightMouseDown = 3
    case mouseMoved = 5
    case leftMouseDragged = 6
    case rightMouseDragged = 7
    case keyDown = 10
    case flagsChanged = 12
    case scrollWheel = 22
    case otherMouseDown = 25
    case otherMouseDragged = 27
}

/// Whether an input event is the person's: one of the watched kinds without our mark.
public func isPersonEvent(userData: Int64, type rawType: UInt32) -> Bool {
    guard WatchedEventType(rawValue: rawType) != nil else { return false }
    return userData != TC_EVENT_MARK
}
