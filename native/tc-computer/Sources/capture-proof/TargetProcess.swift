#if canImport(ScreenCaptureKit)

import AppKit
import Capture

/// The foreign window the proof captures: a second process of capture-proof itself
/// (`capture-proof --target <title>`), an accessory app with one inert titled window showing the
/// probe phrase. It stands in for another app without opening anything of the person's, adding
/// no recent document, and never activating. Scene 11 kills it mid-stream.
@MainActor final class TargetProcess {
    static let title = "TempCode capture target"
    static let phrase = "TempCode capture probe 7319"
    static let lines = [
        phrase,
        "This window belongs to the capture proof's helper process.",
        "It stands in for another app's window.",
        "Nothing here is the person's.",
    ]

    let process: Process
    let windowID: UInt32

    private init(process: Process, windowID: UInt32) {
        self.process = process
        self.windowID = windowID
    }

    static func launch() async throws -> TargetProcess {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        process.arguments = ["--target", title]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.standardError
        try process.run()
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            if let id = window(pid: process.processIdentifier, named: title) {
                return TargetProcess(process: process, windowID: id)
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        process.terminate()
        throw ProofError("the target process's window never appeared")
    }

    var frame: CGRect? { LiveWindows.bounds(windowID) }

    var running: Bool { process.isRunning }

    /// SIGTERM, then SIGKILL after 3 s.
    func kill() async {
        guard process.isRunning else { return }
        process.terminate()
        let deadline = Date().addingTimeInterval(3)
        while process.isRunning, Date() < deadline {
            try? await Task.sleep(for: .milliseconds(25))
        }
        if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
    }

    static func window(pid: pid_t, named name: String) -> UInt32? {
        guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return nil }
        return list.first { info in
            (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
                && ((info[kCGWindowName as String] as? String) ?? "") == name
        }.flatMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value }
    }
}

/// The helper's side: run by main.swift for `--target <title>`.
@MainActor enum TargetWindow {
    private static var window: InertWindow?

    static func show(title: String) {
        let screen = Screens.primary.visibleFrame
        let window = InertWindow(
            contentRect: CGRect(x: screen.minX + 160, y: screen.maxY - 420 - 200, width: 620, height: 420),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        let text = NSTextView(frame: CGRect(x: 0, y: 0, width: 620, height: 420))
        text.isEditable = false
        text.isSelectable = false
        text.drawsBackground = true
        text.backgroundColor = .white
        text.textContainerInset = CGSize(width: 24, height: 24)
        text.font = NSFont.systemFont(ofSize: 20)
        text.textColor = .black
        text.string = TargetProcess.lines.joined(separator: "\n\n")
        window.contentView = text
        window.orderFrontRegardless()
        self.window = window
        // Leave with the proof: a helper whose parent is gone quits.
        let parent = getppid()
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            if getppid() != parent { exit(0) }
        }
    }
}

#endif
