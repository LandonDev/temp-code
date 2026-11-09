#if canImport(ApplicationServices)
import ApplicationServices
@testable import AXReader
import AXText
import ComputerCore
import ComputerProtocol
import Foundation
import Testing

// The live side without a live app: no TCC grant needed, nothing launched.

@Suite struct AXErrorMapTests {
    @Test func everyCallErrorReadsTheOneWay() {
        for e in [AXError.noValue, .attributeUnsupported, .failure, .success] { #expect(AXErrorMap.slot(e).isAbsent, "\(e)") }
        #expect(AXErrorMap.slot(.invalidUIElement).isGone)
        #expect(AXErrorMap.slot(.cannotComplete).isTimeout)
        #expect(AXErrorMap.slot(.apiDisabled).isDisabled)
    }

    @Test func aSlotHoldingAnAXErrorValueIsDecoded() {
        func slot(_ e: AXError) -> Slot {
            var raw = e
            return AXErrorMap.slot(AXValueCreate(.axError, &raw)!)
        }
        #expect(slot(.noValue).isAbsent)
        #expect(slot(.invalidUIElement).isGone)
        #expect(slot(.cannotComplete).isTimeout)
        #expect(AXErrorMap.slot(kCFNull).isAbsent)
        #expect(AXErrorMap.slot("text" as CFString).isValue)
    }

    @Test func aSlotThatEndsTheReadBecomesItsFailure() {
        #expect(AXErrorMap.failure(.gone, what: "The window")?.error.kind == .windowNotFound)
        #expect(AXErrorMap.failure(.timeout, what: "The window")?.error.kind == .timeout)
        let grant = AXErrorMap.failure(.disabled, what: "The window")?.error
        #expect(grant?.kind == .permissionMissing && grant?.which == .accessibility)
        #expect(AXErrorMap.failure(.absent, what: "x") == nil)
    }
}

@Suite struct HandleTableTests {
    @Test func theSameElementInternsToOneId() {
        let table = HandleTable()
        let a = table.intern(AXUIElementCreateApplication(getpid()))
        let b = table.intern(AXUIElementCreateApplication(getpid()))
        #expect(a == b)
        #expect(table.intern(AXUIElementCreateApplication(1)) != a)
        #expect(table.element(a).map { CFEqual($0, AXUIElementCreateApplication(getpid())) } == true)
    }

    @Test func pastCapacityTheHandlesUsedLongestAgoGo() {
        let table = HandleTable(capacity: 2)
        let first = table.intern(AXUIElementCreateApplication(1))
        let second = table.intern(AXUIElementCreateApplication(2))
        _ = table.intern(AXUIElementCreateApplication(1))
        let third = table.intern(AXUIElementCreateApplication(3))
        table.trim()
        #expect(table.count == 2)
        #expect(table.element(second) == nil && table.element(first) != nil && table.element(third) != nil)
    }
}

@Suite struct WindowIDLookupTests {
    let frame = ComputerProtocol.Rect(x: 100, y: 80, w: 640, h: 480)

    @Test func aMissingSymbolFallsBackToTheWindowList() {
        let me = getpid()
        let list = [
            WindowListEntry(id: 31, pid: me, title: "Scratch", bounds: frame, onScreen: true),
            WindowListEntry(id: 32, pid: me, title: "Other", bounds: frame, onScreen: true)
        ]
        let window = AXUIElementCreateApplication(me)
        #expect(WindowIDLookup.missing.id(of: window, pid: me, title: "Scratch", frame: frame, list: { list }) == 31)
        #expect(WindowIDLookup.missing.id(of: window, pid: me, title: "Gone", frame: frame, list: { list }) == nil)
        // a lookup that answers wins over the list
        #expect(WindowIDLookup { _ in 99 }.id(of: window, pid: me, title: "Scratch", frame: frame, list: { list }) == 99)
    }

    @Test func theLiveLookupResolvesItsSymbolByName() {
        // present on the macOS this runs on, or missing: either way a lookup exists and answers
        _ = WindowIDLookup.live.lookup(AXUIElementCreateApplication(getpid()))
    }
}

@Suite struct ChangeMonitorTests {
    @Test func aNotificationMovesTheClockAndOnlyAnIndicatorJoinsTheCandidates() {
        let monitor = ChangeMonitor(pid: getpid(), app: AXUIElementCreateApplication(getpid()))
        defer { monitor.close() }
        let before = monitor.lastChange
        monitor.heard(AXUIElementCreateApplication(getpid()), kAXCreatedNotification)
        #expect(monitor.lastChange > before)
        // the application element is no busy indicator, and with no candidate nothing shows
        #expect(!monitor.busyIndicatorShowing())
    }
}

extension Slot {
    var isAbsent: Bool { if case .absent = self { true } else { false } }
    var isGone: Bool { if case .gone = self { true } else { false } }
    var isTimeout: Bool { if case .timeout = self { true } else { false } }
    var isDisabled: Bool { if case .disabled = self { true } else { false } }
    var isValue: Bool { if case .value = self { true } else { false } }
}
#endif
