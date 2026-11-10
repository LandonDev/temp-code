// computer-probe-app: the scratch app scripts/e2e-tc-computer.ts drives. One window "TC Probe" with a
// text field, a button "Ping" and a label the button sets to "pong". Built by the proof into
// /tmp/tc-computer-proof/TC Probe.app (bundle id dev.landon.tempcode.computer-probe), signed ad hoc,
// never shipped.
//
// A regular app, so apps.list lists it, that never activates itself: tc-computer launches it in the
// background and it stays there. Its window is inert: it never becomes key or main and takes no click,
// so it takes none of the person's input, and it goes to the back; AX reads it and presses its button all
// the same. It keeps the normal level: the window list's match, the private symbol's fallback, takes
// layer 0 alone. It keeps no saved state, so quitting it leaves
// nothing behind.
//
// `--tick` (opt-in, for the preview proof): a label under the button counts about ten times a second, so
// the window's pixels change and a capture stream, which sends a frame only when they do, keeps sending.
// SIGUSR1 pauses the count and the next one resumes it, for a check that needs the window still.
//
// `--windows` (opt-in, for the window actions leg; docs/computer-protocol.md §22): see ProbeWindows below.
import AppKit

/// A window the person can neither click nor bring forward.
final class InertWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class ProbeDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private let result = NSTextField(labelWithString: "waiting")
    private let tick = NSTextField(labelWithString: "")
    private var ticks = 0
    private var tickPaused = false
    private var pauseSignal: DispatchSourceSignal?
    private let windows = ProbeWindows()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let ticking = CommandLine.arguments.contains("--tick")
        let window = InertWindow(
            contentRect: NSRect(x: 160, y: 160, width: 360, height: ticking ? 180 : 150),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "TC Probe"
        window.isReleasedWhenClosed = false
        window.isRestorable = false

        let field = NSTextField(string: "")
        field.placeholderString = "Probe text"
        let ping = NSButton(title: "Ping", target: self, action: #selector(ping(_:)))

        let stack = NSStackView(views: ticking ? [field, ping, result, tick] : [field, ping, result])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            field.widthAnchor.constraint(equalToConstant: 320),
        ])
        window.contentView = content

        // On screen for AX and capture, behind every other window, and never key: no activate call.
        window.ignoresMouseEvents = true
        window.orderBack(nil)
        self.window = window

        if CommandLine.arguments.contains("--windows") { windows.open() }

        if ticking {
            tick.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
            tick.stringValue = "tick 0"
            Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                guard let self, !self.tickPaused else { return }
                self.ticks += 1
                self.tick.stringValue = "tick \(self.ticks)"
            }
            signal(SIGUSR1, SIG_IGN)
            let pause = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
            pause.setEventHandler { [weak self] in self?.tickPaused.toggle() }
            pause.resume()
            pauseSignal = pause
        }
    }

    @objc private func ping(_ sender: Any?) {
        result.stringValue = "pong"
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { false }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

// MARK: --windows

/// A window the person can neither click nor make key, which may still become main, so AppKit gives it
/// the standard-window subrole and §2.1 may pick it as the app's default.
final class SideWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { true }
}

/// Three windows beside "TC Probe" for the window actions leg: "TC Probe Doc" (close, minimize, an
/// edited document whose close asks "Don't Save" or "Cancel" in a sheet; a field, Ping and a checkbox so
/// its tree is not thin), "TC Probe Plain" (close and minimize) and "TC Probe Fixed" (neither). All
/// ordered back, mouse-inert and never activated, like the probe window.
final class ProbeWindows: NSObject, NSWindowDelegate {
    private var all: [NSWindow] = []
    private let pong = NSTextField(labelWithString: "waiting")

    func open() {
        let doc = make("TC Probe Doc", [.titled, .closable, .miniaturizable], at: 560, rows: [
            NSTextField(string: ""), NSButton(title: "Ping", target: self, action: #selector(ping(_:))),
            NSButton(checkboxWithTitle: "Keep", target: nil, action: nil), pong
        ])
        doc.isDocumentEdited = true
        doc.delegate = self
        make("TC Probe Plain", [.titled, .closable, .miniaturizable], at: 960, rows: [NSTextField(labelWithString: "Plain")])
        make("TC Probe Fixed", [.titled], at: 1_360, rows: [NSTextField(labelWithString: "Fixed")])
    }

    @discardableResult
    private func make(_ title: String, _ style: NSWindow.StyleMask, at x: CGFloat, rows: [NSView]) -> NSWindow {
        let window = SideWindow(contentRect: NSRect(x: x, y: 160, width: 360, height: 170), styleMask: style, backing: .buffered, defer: false)
        window.title = title
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        let stack = NSStackView(views: rows)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        window.contentView = stack
        window.ignoresMouseEvents = true
        window.orderBack(nil)
        all.append(window)
        return window
    }

    @objc private func ping(_ sender: Any?) { pong.stringValue = "pong" }

    /// An edited document asks before it closes, in a sheet on its window, as TextEdit's does.
    func windowShouldClose(_ window: NSWindow) -> Bool {
        guard window.isDocumentEdited else { return true }
        let alert = NSAlert()
        alert.messageText = "Close \(window.title) without saving?"
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Don't Save")
        alert.beginSheetModal(for: window) { response in
            guard response == .alertSecondButtonReturn else { return }
            window.isDocumentEdited = false
            window.close()
        }
        return false
    }
}

UserDefaults.standard.register(defaults: ["ApplePersistenceIgnoreState": true])
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = ProbeDelegate()
app.delegate = delegate
app.run()
