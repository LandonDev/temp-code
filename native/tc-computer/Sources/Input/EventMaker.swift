import CoreGraphics
import Foundation

/// SyntheticEvent → CGEvent: the type, location, button and click state, flags, the target
/// window's fields, scroll deltas, the key code or Unicode string, and the mark.
public enum EventMaker {
    /// `.mouseEventWindowUnderMousePointer` and `…ThatCanHandleThisEvent`: the app routes a posted mouse event to this window.
    static let windowField = CGEventField(rawValue: 91)!
    static let handlerWindowField = CGEventField(rawValue: 92)!

    static func flags(_ m: Modifiers) -> CGEventFlags {
        var f: CGEventFlags = []
        if m.contains(.shift) { f.insert(.maskShift) }
        if m.contains(.control) { f.insert(.maskControl) }
        if m.contains(.option) { f.insert(.maskAlternate) }
        if m.contains(.command) { f.insert(.maskCommand) }
        return f
    }

    static func cgButton(_ b: MouseButton) -> CGMouseButton {
        switch b {
        case .left: .left
        case .right: .right
        case .middle: .center
        }
    }

    static func downType(_ b: MouseButton) -> CGEventType {
        switch b {
        case .left: .leftMouseDown
        case .right: .rightMouseDown
        case .middle: .otherMouseDown
        }
    }

    static func upType(_ b: MouseButton) -> CGEventType {
        switch b {
        case .left: .leftMouseUp
        case .right: .rightMouseUp
        case .middle: .otherMouseUp
        }
    }

    static func dragType(_ b: MouseButton) -> CGEventType {
        switch b {
        case .left: .leftMouseDragged
        case .right: .rightMouseDragged
        case .middle: .otherMouseDragged
        }
    }

    /// The event, or nil for a pause. `windowID` (non-zero) goes in a mouse event's window fields.
    public static func make(_ e: SyntheticEvent, windowID: UInt32?, source: CGEventSource?) -> CGEvent? {
        var mouse = false
        let event: CGEvent?
        switch e {
        case .move(let p, let dragging):
            mouse = true
            event = CGEvent(mouseEventSource: source, mouseType: dragging.map(dragType) ?? .mouseMoved, mouseCursorPosition: p.cg, mouseButton: cgButton(dragging ?? .left))
            if let dragging, dragging == .middle { event?.setIntegerValueField(.mouseEventButtonNumber, value: 2) }
        case .down(let b, let p, let state, let m), .up(let b, let p, let state, let m):
            mouse = true
            let isDown = if case .down = e { true } else { false }
            event = CGEvent(mouseEventSource: source, mouseType: isDown ? downType(b) : upType(b), mouseCursorPosition: p.cg, mouseButton: cgButton(b))
            event?.setIntegerValueField(.mouseEventClickState, value: Int64(state))
            if b == .middle { event?.setIntegerValueField(.mouseEventButtonNumber, value: 2) }
            event?.flags = flags(m)
        case .scroll(let lines, let axis, let p, let m):
            mouse = true
            event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: axis == .vertical ? lines : 0, wheel2: axis == .horizontal ? lines : 0, wheel3: 0)
            event?.location = p.cg
            event?.setIntegerValueField(.scrollWheelEventIsContinuous, value: 0)
            event?.flags = flags(m)
        case .modifier(let code, let down, let m):
            event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
            event?.type = .flagsChanged
            event?.flags = flags(m)
        case .key(let code, let down, let m):
            event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
            event?.flags = flags(m)
        case .unicode(let s, let down):
            event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
            let units = Array(s.utf16)
            units.withUnsafeBufferPointer { event?.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
            event?.flags = []
        case .pause:
            return nil
        }
        guard let event else { return nil }
        event.setIntegerValueField(.eventSourceUserData, value: TC_EVENT_MARK)
        if mouse, let windowID, windowID != 0 {
            event.setIntegerValueField(windowField, value: Int64(windowID))
            event.setIntegerValueField(handlerWindowField, value: Int64(windowID))
        }
        return event
    }
}

extension ScreenPoint {
    var cg: CGPoint { CGPoint(x: x, y: y) }
    init(_ p: CGPoint) { self.init(x: p.x, y: p.y) }
}
