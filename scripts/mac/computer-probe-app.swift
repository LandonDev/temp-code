// computer-probe-app: the scratch app scripts/e2e-tc-computer.ts drives. One window "TC Probe" with a
// text field, a button "Ping" and a label the button sets to "pong". Built by the proof into
// /tmp/tc-computer-proof/TC Probe.app (bundle id dev.landon.tempcode.computer-probe), signed ad hoc,
// never shipped.
//
// A regular app, so apps.list lists it, that never activates itself: tc-computer launches it in the
// background and it stays there. Its window is inert: it never becomes key or main, takes no click and
// sits a level below every normal window, so it covers nothing the person sees and takes none of their
// input; AX reads it and presses its button all the same. It keeps no saved state, so quitting it leaves
// nothing behind.
import AppKit

/// A window the person can neither click nor bring forward.
final class InertWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class ProbeDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private let result = NSTextField(labelWithString: "waiting")

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = InertWindow(
            contentRect: NSRect(x: 160, y: 160, width: 360, height: 150),
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

        let stack = NSStackView(views: [field, ping, result])
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

        // On screen for AX and capture, below every normal window, and never key: no activate call.
        window.ignoresMouseEvents = true
        window.level = NSWindow.Level(rawValue: NSWindow.Level.normal.rawValue - 1)
        window.orderBack(nil)
        self.window = window
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
