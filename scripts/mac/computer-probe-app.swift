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

        if ticking {
            tick.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
            tick.stringValue = "tick 0"
            Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                guard let self else { return }
                self.ticks += 1
                self.tick.stringValue = "tick \(self.ticks)"
            }
        }
    }

    @objc private func ping(_ sender: Any?) {
        result.stringValue = "pong"
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { false }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

UserDefaults.standard.register(defaults: ["ApplePersistenceIgnoreState": true])
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = ProbeDelegate()
app.delegate = delegate
app.run()
