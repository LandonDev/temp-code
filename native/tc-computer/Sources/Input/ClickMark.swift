import ComputerCore
import ComputerProtocol

/// Where a click-class action acted (P2): the shell marks it on the window's preview stream.
public enum ClickMark {
    /// The five clicks, `left_mouse_down` and `perform`.
    public static func isClickClass(_ name: ComputerActionName) -> Bool {
        switch name {
        case .leftClick, .rightClick, .middleClick, .doubleClick, .tripleClick, .leftMouseDown, .perform: true
        default: false
        }
    }

    /// At an event tier: the pointer's point after the step, in the window's session space.
    public static func eventPoint(_ name: ComputerActionName, at: ScreenPoint?, frame: ComputerProtocol.Rect, space: CoordinateSpace) -> [Int]? {
        guard isClickClass(name), let at else { return nil }
        return toSpace(at, frame: frame, space: space)
    }

    /// At `ax`: the centre of the element's frame from the tree's geometry, clipped to its scroll area's
    /// visible frame and to the window as Input places a pointer for it; nil when none of it shows.
    public static func axPoint(frame: ComputerProtocol.Rect, visible: ComputerProtocol.Rect?, window: ComputerProtocol.Rect, space: CoordinateSpace) -> [Int]? {
        pointIn(frame, visible: visible, window: window).map { toSpace($0, frame: window, space: space) }
    }
}
