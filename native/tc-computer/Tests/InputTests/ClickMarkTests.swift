import ComputerCore
import ComputerProtocol
@testable import Input
import Testing

@Suite struct ClickMarkTests {
    let window = Rect(x: 100, y: 50, w: 800, h: 600)
    let space = CoordinateSpace(width: 1600, height: 1200, scale: 2)

    @Test func theClickClassIsTheFiveClicksTheDownAndPerform() {
        let yes: [ComputerActionName] = [.leftClick, .rightClick, .middleClick, .doubleClick, .tripleClick, .leftMouseDown, .perform]
        let no: [ComputerActionName] = [.mouseMove, .leftMouseUp, .leftClickDrag, .scroll, .key, .type, .setValue, .selectText, .cursorPosition]
        #expect(yes.allSatisfy(ClickMark.isClickClass))
        #expect(!no.contains(where: ClickMark.isClickClass))
    }

    @Test func anAXPressMarksTheCentreOfTheElementsFrame() {
        // a button at (300, 150) 100×40 points: centre (350, 170), in the window's space ×2 from its origin
        #expect(ClickMark.axPoint(frame: Rect(x: 300, y: 150, w: 100, h: 40), visible: nil, window: window, space: space) == [500, 240])
    }

    @Test func anAXPressMarksTheVisiblePartInsideItsScrollArea() {
        // a row half under its scroll area's top edge: only its lower half shows
        let row = Rect(x: 200, y: 180, w: 200, h: 40)
        let area = Rect(x: 150, y: 200, w: 500, h: 300)
        #expect(ClickMark.axPoint(frame: row, visible: area, window: window, space: space) == [400, 320])
        #expect(ClickMark.axPoint(frame: Rect(x: 200, y: 100, w: 50, h: 20), visible: area, window: window, space: space) == nil)
    }

    @Test func aCoordinateClickMarksWhereThePointerWent() throws {
        let coordinate = [300, 200]
        let at = try toScreen(coordinate, frame: window, space: space)
        #expect(ClickMark.eventPoint(.leftClick, at: at, frame: window, space: space) == coordinate)
        #expect(ClickMark.eventPoint(.leftMouseDown, at: at, frame: window, space: space) == coordinate)
        #expect(ClickMark.eventPoint(.mouseMove, at: at, frame: window, space: space) == nil)
        #expect(ClickMark.eventPoint(.leftClick, at: nil, frame: window, space: space) == nil)
    }
}
