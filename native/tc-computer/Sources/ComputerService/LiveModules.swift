import ApplicationServices
import ComputerCore
import ComputerProtocol
import struct ComputerProtocol.WindowRef
import Foundation

extension Modules {
    /// The binary's modules. Until the AX reader, Input and Capture builds land, every call into them
    /// answers that it is not built; the shell's own methods work.
    public static func live() -> Modules {
        Modules(
            readers: { NotBuilt() },
            input: { _ in NotBuilt() },
            capture: { NotBuilt() },
            windows: NotBuilt()
        )
    }
}

/// Stands in for a module that has not landed.
final class NotBuilt: ReaderPool, WindowSource, CaptureSource, InputPerforming, @unchecked Sendable {
    private var failure: ComputerError {
        ComputerError(kind: .captureFailed, message: "This build of tc-computer has no AX reader, Input or Capture module yet.")
    }

    func reader(session: String, pid: pid_t) throws -> any AppReading { throw failure }
    func close(session: String) {}
    func resolve(pid: pid_t, ref: WindowRef?) throws -> (element: AXUIElement, info: WindowInfo) { throw failure }
    func list(pid: pid_t) throws -> [WindowInfo] { throw failure }
    func windowID(of element: AXUIElement, pid: pid_t) -> UInt32? { nil }
    func invalidate() {}
    func space(windowID: UInt32, frame: Rect, maxEdge: Int) -> CoordinateSpace { CoordinateSpace(width: 1, height: 1, scale: 1) }
    func nextStem(dataDir: String, session: String, action: String) throws -> String { throw failure }
    func forget(session: String) {}
    func screenshot(windowID: UInt32, maxEdge: Int, regionPoints: Rect?, format: ShotFormat?, to stem: String) async throws -> Shot { throw failure }
    func startStream(windowID: UInt32, fps: Int, maxEdge: Int, onFrame: @escaping @Sendable (Frame) -> Void) async throws -> any StreamHandle { throw failure }
    func watch(windowID: UInt32) async throws -> any PixelChangeSignal { throw failure }
    func perform(_ action: ComputerAction, on target: InputTarget, tiers: [Tier]) throws -> InputOutcome { throw failure }
    func probe(_ target: InputTarget, classes: [ActionClass]) throws -> ProbeReport { throw failure }
    func restoreSession() throws -> SessionRestore { throw failure }
    func releaseHeld(pid: pid_t) {}
    func releaseStale(_ record: HeldRecord) {}
}
