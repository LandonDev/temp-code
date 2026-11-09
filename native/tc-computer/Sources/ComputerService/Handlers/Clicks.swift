import ComputerProtocol
import ComputerServiceKit
import Foundation

/// P2: the agent's clicks on a streamed window (docs/computer-protocol.md §6).
extension ComputerService {
    /// A step clicked at `at` (session space `space`) on the window: each of the session's streams on that
    /// window is sent `capture/click` at once, whether or not a pixel changes, and the click is carried
    /// for a stream that starts on it later.
    func clicked(_ at: [Int], space: CoordinateSpace, session: String, windowID: UInt32, call: Int) {
        let click = ClickCarry.Click(at: at, spaceWidth: space.width, spaceHeight: space.height)
        let on: [StreamEntry] = lock.withLock {
            clicks.record(click, session: session, windowID: windowID, call: call)
            return streams.values.filter { $0.session == session && $0.windowID == windowID }
        }
        for entry in on { sendClick(click, on: entry) }
    }

    /// The request that clicked answered: its clicks are carried `clickCarryMs` from now.
    func clickCallAnswered(_ call: Int) {
        let now = env.system.now()
        lock.withLock { clicks.answered(call: call, at: now) }
    }

    /// `at` in the stream's frame pixels, with that frame's size.
    func sendClick(_ click: ClickCarry.Click, on entry: StreamEntry) {
        let size = entry.size.current
        guard size.width > 0, size.height > 0 else { return }
        let at = ClickMapping.map(click, frameWidth: size.width, frameHeight: size.height)
        notify("capture/click", CaptureClickNotification.Params(stream: entry.id, at: at, width: size.width, height: size.height))
    }
}
