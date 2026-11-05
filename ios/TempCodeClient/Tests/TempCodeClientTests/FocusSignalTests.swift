import Foundation
import Testing
@testable import TempCodeClient

/// `session.focus` from the phone: the thread on screen named once per
/// change, again after a reconnect, never by a key below operate.
@Suite struct FocusSignalTests {
    @Test func `names the thread once, then null when the app leaves the screen`() {
        var signal = FocusSignal()
        #expect(signal.want("t1", canSend: true) == .some("t1"))
        #expect(signal.want("t1", canSend: true) == nil)
        #expect(signal.want(nil, canSend: true) == .some(nil))
        #expect(signal.want(nil, canSend: true) == nil)
    }

    @Test func `says nothing before anything was named`() {
        var signal = FocusSignal()
        #expect(signal.want(nil, canSend: true) == nil)
    }

    @Test func `a read key sends nothing`() {
        var signal = FocusSignal()
        #expect(signal.want("t1", canSend: false) == nil)
        #expect(signal.sent == nil)
    }

    @Test func `a reconnect names the thread on screen again`() {
        var signal = FocusSignal()
        _ = signal.want("t1", canSend: true)
        signal.reconnected()
        #expect(signal.want("t1", canSend: true) == .some("t1"))
    }

    @Test func `another thread replaces the first`() {
        var signal = FocusSignal()
        _ = signal.want("t1", canSend: true)
        #expect(signal.want("t2", canSend: true) == .some("t2"))
    }
}
