import AppKit
import ApplicationServices
import ComputerProtocol
import struct ComputerProtocol.WindowRef
import ComputerServiceKit
import Foundation

/// `tc-computer serve | permissions [--prompt] | version | hold-lock clipboard|session <ms>` (shell §12.3).
/// The one-shot commands write their one JSON line to stdout through the writer `serve` uses.
public enum CommandLineTool {
    public static let usage = "usage: tc-computer serve | permissions [--prompt] | version | hold-lock clipboard|session <ms>"

    /// The service the process serves; kept for the process's life.
    nonisolated(unsafe) static var service: ComputerService?

    @MainActor
    public static func main(_ arguments: [String]) -> Never {
        signal(SIGPIPE, SIG_IGN)
        guard ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 14, minorVersion: 0, patchVersion: 0)) else {
            stderr("tc-computer needs macOS 14 or later")
            exit(Lifecycle.Code.unsupported)
        }
        let executable = Bundle.main.executableURL
        switch arguments.first {
        case "serve" where arguments.count == 1:
            serve(executable: executable)
        case "permissions" where arguments.count <= 2 && (arguments.count == 1 || arguments[1] == "--prompt"):
            if arguments.count == 2 {
                _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
                _ = CGRequestScreenCaptureAccess()
            }
            emit(Permissions(accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess()))
            exit(0)
        case "version" where arguments.count == 1:
            let build = BuildInfo.read(stampBeside: executable)
            emit(VersionLine(version: build.version, build: build.build, protocol: computerProtocol))
            exit(0)
        case "hold-lock" where arguments.count == 3:
            guard let name = MacLockName(rawValue: arguments[1]), let ms = Int(arguments[2]), ms >= 0 else { break }
            holdLock(name, ms: ms)
        default:
            break
        }
        stderr(usage)
        exit(Lifecycle.Code.usage)
    }

    @MainActor
    private static func serve(executable: URL?) -> Never {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let modules = Modules.live()
        modules.prepare()
        let service = ComputerService(
            modules: modules, environment: .live(windows: modules.windows, executable: executable),
            build: BuildInfo.read(stampBeside: executable), trace: .fromEnvironment(), sink: FileDescriptorSink(fd: STDOUT_FILENO)
        )
        CommandLineTool.service = service
        service.start(input: STDIN_FILENO)
        NSApp.run()
        exit(0)
    }

    /// Takes a Mac-wide lock, says so once it holds it, lets go after `ms`.
    private static func holdLock(_ name: MacLockName, ms: Int) -> Never {
        guard let lease = MacLocks().acquire(name, timeout: .seconds(10)) else {
            emit(["held": false])
            exit(1)
        }
        emit(["held": true])
        usleep(useconds_t(ms) * 1_000)
        lease.release()
        exit(0)
    }

    private static func emit(_ value: some Encodable) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard var line = try? encoder.encode(value) else { return }
        line.append(0x0A)
        try? FileDescriptorSink(fd: STDOUT_FILENO).write(line)
    }

    private struct VersionLine: Encodable {
        let version: String
        let build: String
        let `protocol`: Int
    }

    private static func stderr(_ text: String) {
        FileHandle.standardError.write(Data((text + "\n").utf8))
    }
}
