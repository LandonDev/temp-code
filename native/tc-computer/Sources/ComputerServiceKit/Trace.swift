import ComputerProtocol
import Foundation

/// `TEMP_CODE_COMPUTER_TRACE=1`: every frame in (`→`) and out (`←`), every lock taken and let go, every
/// wait's report, on stderr with a millisecond timestamp. Off, stderr carries warnings and errors only.
public final class Trace: @unchecked Sendable {
    public static let variable = "TEMP_CODE_COMPUTER_TRACE"
    /// a line past this many characters is cut with `…(+N)`
    public static let lineMaxChars = 2_000

    public let enabled: Bool
    private let write: @Sendable (String) -> Void
    private let started = ContinuousClock.now

    public init(enabled: Bool, write: @escaping @Sendable (String) -> Void) {
        self.enabled = enabled
        self.write = write
    }

    /// On when the environment says `1`; writes to stderr.
    public static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> Trace {
        Trace(enabled: environment[variable] == "1", write: { text in
            FileHandle.standardError.write(Data((text + "\n").utf8))
        })
    }

    public func frameIn(_ line: Data) {
        guard enabled else { return }
        emit("→ " + Trace.frameText(line))
    }

    public func frameOut(_ line: Data) {
        guard enabled else { return }
        emit("← " + Trace.frameText(line))
    }

    /// A lock taken: how long the acquire waited, or nil when it gave up.
    public func lockTaken(_ name: String, waitedMs: Int, got: Bool) {
        guard enabled else { return }
        emit(got ? "lock \(name) taken after \(waitedMs)ms" : "lock \(name) refused after \(waitedMs)ms")
    }

    public func lockReleased(_ name: String, heldMs: Int) {
        guard enabled else { return }
        emit("lock \(name) released after \(heldMs)ms")
    }

    public func wait(_ report: WaitReport, ax: Int, sig: Int, px: Int) {
        guard enabled else { return }
        emit(Trace.waitText(report, ax: ax, sig: sig, px: px))
    }

    public func note(_ text: String) {
        guard enabled else { return }
        emit(text)
    }

    /// Always written.
    public func warn(_ text: String) { emit("warn: " + text) }

    /// Always written.
    public func error(_ text: String) { emit("error: " + text) }

    private func emit(_ text: String) {
        write(Trace.stamp(ContinuousClock.now - started) + " " + Trace.cut(text))
    }

    // MARK: Pure

    /// `[   12.345]`: seconds since the trace began, to the millisecond.
    public static func stamp(_ elapsed: Duration) -> String {
        let ms = elapsed.components.seconds * 1_000 + elapsed.components.attoseconds / 1_000_000_000_000_000
        let text = "\(ms / 1_000).\(String(repeating: "0", count: 3 - String(ms % 1_000).count))\(ms % 1_000)"
        return "[" + String(repeating: " ", count: max(0, 9 - text.count)) + text + "]"
    }

    /// The frame as text, a `capture/frame`'s JPEG as `<jpeg N bytes>`.
    public static func frameText(_ line: Data) -> String {
        var text = String(decoding: line, as: UTF8.self)
        if text.hasSuffix("\n") { text.removeLast() }
        guard text.contains("\"method\":\"capture/frame\""), let open = text.range(of: "\"data\":\"") else { return text }
        guard let close = text[open.upperBound...].firstIndex(of: "\"") else { return text }
        let base64 = text[open.upperBound..<close]
        let padding = base64.reversed().prefix(while: { $0 == "=" }).count
        let bytes = base64.count / 4 * 3 - padding
        return text.replacingCharacters(in: open.upperBound..<close, with: "<jpeg \(bytes) bytes>")
    }

    /// `wait 812ms quiet ax=3 sig=1 px=0`.
    public static func waitText(_ report: WaitReport, ax: Int, sig: Int, px: Int) -> String {
        "wait \(report.waitedMs)ms \(report.reason.rawValue) ax=\(ax) sig=\(sig) px=\(px)" + (report.busy ? " busy" : "")
    }

    public static func cut(_ text: String) -> String {
        guard text.count > lineMaxChars else { return text }
        return String(text.prefix(lineMaxChars)) + "…(+\(text.count - lineMaxChars))"
    }
}
