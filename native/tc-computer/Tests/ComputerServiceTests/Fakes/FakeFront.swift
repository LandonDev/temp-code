import ComputerProtocol
@testable import ComputerService
import ComputerServiceKit
import Foundation

/// The front as the guard reads and moves it. The person's app is pid 100 until a test says otherwise; a
/// move the guard makes is told back as NSWorkspace would, through `onActivate` and `onFocus`.
final class FakeFrontSource: FrontSource, @unchecked Sendable {
    private let lock = NSLock()
    private var front: Int32? = 100
    private var focused: [Int32: UInt32] = [:]
    private var isAbove = false
    private var files: [String: FileFacts] = [:]
    private var made: [String] = []
    private var handler: (@Sendable (FrontEvent) -> Void)?
    /// the activation NSWorkspace tells after AXFrontmost
    var onActivate: (@Sendable (Int32) -> Void)?
    /// the focus change AX tells after AXRaise on a window
    var onFocus: (@Sendable (Int32, UInt32) -> Void)?

    func now() -> Double { ProcessInfo.processInfo.systemUptime * 1_000 }
    func frontmost() -> Int32? { lock.withLock { front } }
    func focusedWindow(pid: Int32) -> UInt32? { lock.withLock { focused[pid] } }

    func setFrontmost(pid: Int32) -> Bool {
        lock.withLock {
            made.append("frontmost \(pid)")
            front = pid
        }
        lock.withLock { onActivate }?(pid)
        return true
    }

    func raise(pid: Int32, window: UInt32?) -> Bool {
        let raised: UInt32? = lock.withLock {
            made.append("raise \(pid) \(window.map(String.init) ?? "focused")")
            if let window { focused[pid] = window }
            isAbove = false
            return window
        }
        if let raised { lock.withLock { onFocus }?(pid, raised) }
        return true
    }

    func orderedAbove(pid: Int32, over: Int32) -> Bool { lock.withLock { isAbove } }

    func hide(pid: Int32) -> Bool {
        lock.withLock { made.append("hide \(pid)") }
        return true
    }

    func startSignals(_ handler: @escaping @Sendable (FrontEvent) -> Void) { lock.withLock { self.handler = handler } }
    func stopSignals() { lock.withLock { handler = nil } }
    func fileFacts(path: String) -> FileFacts? { lock.withLock { files[path] } }

    // MARK: The test's hand

    /// What the guard did to the front, in order.
    var calls: [String] { lock.withLock { made } }
    var listening: Bool { lock.withLock { handler != nil } }

    func set(front pid: Int32?) { lock.withLock { front = pid } }
    func set(focused window: UInt32, of pid: Int32) { lock.withLock { focused[pid] = window } }
    func set(above: Bool) { lock.withLock { isAbove = above } }
    func set(_ path: String, _ facts: FileFacts) { lock.withLock { files[path] = facts } }
    /// The person's click or key, as the monitor hears it.
    func person(_ event: FrontEvent) { lock.withLock { handler }?(event) }
}
