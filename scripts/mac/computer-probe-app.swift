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
//
// `--fallbacks <dir>` (opt-in, for the background fallbacks leg; §24): see ProbeFallbacks below.
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
    private let fallbacks = ProbeFallbacks()

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
        if let at = CommandLine.arguments.firstIndex(of: "--fallbacks"), at + 1 < CommandLine.arguments.count {
            fallbacks.open(scratch: CommandLine.arguments[at + 1])
        }

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

// MARK: --fallbacks

/// A window that may be key in its app, as a document window is, while the app stays in the background:
/// the menu route needs the target to be the app's focused window (§24.2).
final class KeyableWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

/// A custom view with the button role and a label child of its own: a click on the label hits the
/// label, and the hit route walks up to the button (§24.3).
final class HitTarget: NSView {
    var onPress: () -> Void = {}

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .button }
    override func accessibilityLabel() -> String? { "Hit Target" }
    override func accessibilityPerformPress() -> Bool {
        onPress()
        return true
    }
}

/// The content view, in the responder chain: "Ping Window" has no target and lands here.
final class FallbackContent: NSView {
    var onPing: () -> Void = {}
    override var acceptsFirstResponder: Bool { true }
    @objc func pingWindow(_ sender: Any?) { onPing() }
}

/// "TC Probe Fallbacks", for the background fallbacks leg: the Hit Target with its counter, an editable
/// field of ten digits in a monospaced font (so the leg can aim at a character), a plain text view, a
/// stepper with its value, a scroll view over 60 lines, and "Save…", which opens a save sheet on the
/// window aimed at the run's scratch folder. A "Probe" menu holds "Ping App" (⌘⇧P, aimed at this object)
/// and "Ping Window" (⌘⇧K, no target: the responder chain from the key window). The window is ordered back,
/// mouse-inert and made key in its app, which is never activated.
final class ProbeFallbacks: NSObject {
    private var window: NSWindow?
    private var scratch = ""
    private var hits = 0
    private var appPings = 0
    private var windowPings = 0
    private let hitCount = NSTextField(labelWithString: "hits 0")
    private let pings = NSTextField(labelWithString: "app 0 window 0")
    private let stepper = NSStepper()
    private let stepValue = NSTextField(labelWithString: "value 5")

    func open(scratch: String) {
        self.scratch = scratch
        installMenu()
        let window = KeyableWindow(contentRect: NSRect(x: 560, y: 360, width: 420, height: 520), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "TC Probe Fallbacks"
        window.isReleasedWhenClosed = false
        window.isRestorable = false

        let target = HitTarget(frame: NSRect(x: 0, y: 0, width: 160, height: 28))
        let label = NSTextField(labelWithString: "Hit Target")
        label.frame = NSRect(x: 8, y: 4, width: 140, height: 20)
        target.addSubview(label)
        target.translatesAutoresizingMaskIntoConstraints = false
        target.onPress = { [weak self] in self?.hit() }

        let field = NSTextField(string: "0123456789")
        field.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        field.setAccessibilityLabel("Digits")

        let plain = NSTextView(frame: NSRect(x: 0, y: 0, width: 320, height: 40))
        plain.string = "plain text"
        plain.setAccessibilityLabel("Plain")

        stepper.minValue = 0
        stepper.maxValue = 10
        stepper.integerValue = 5
        stepper.target = self
        stepper.action = #selector(stepped(_:))

        let lines = (1 ... 60).map { "line \($0)" }.joined(separator: "\n")
        let scroll = NSTextView.scrollableTextView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        (scroll.documentView as? NSTextView)?.string = lines
        (scroll.documentView as? NSTextView)?.isEditable = false
        scroll.setAccessibilityLabel("Lines")

        let save = NSButton(title: "Save…", target: self, action: #selector(save(_:)))

        let stack = NSStackView(views: [target, hitCount, field, plain, NSStackView(views: [stepper, stepValue]), scroll, save, pings])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = FallbackContent()
        content.onPing = { [weak self] in self?.ping(window: true) }
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            target.widthAnchor.constraint(equalToConstant: 160),
            target.heightAnchor.constraint(equalToConstant: 28),
            field.widthAnchor.constraint(equalToConstant: 320),
            plain.widthAnchor.constraint(equalToConstant: 320),
            plain.heightAnchor.constraint(equalToConstant: 40),
            scroll.widthAnchor.constraint(equalToConstant: 320),
            scroll.heightAnchor.constraint(equalToConstant: 120),
        ])
        window.contentView = content
        window.ignoresMouseEvents = true
        window.orderBack(nil)
        // key in its app, the app still in the background: no activate call
        window.makeKey()
        window.makeFirstResponder(content)
        self.window = window
    }

    private func installMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit TC Probe", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)
        let probeItem = NSMenuItem()
        let probe = NSMenu(title: "Probe")
        let app = NSMenuItem(title: "Ping App", action: #selector(pingApp(_:)), keyEquivalent: "p")
        app.keyEquivalentModifierMask = [.command, .shift]
        app.target = self
        let window = NSMenuItem(title: "Ping Window", action: #selector(FallbackContent.pingWindow(_:)), keyEquivalent: "k")
        window.keyEquivalentModifierMask = [.command, .shift]
        probe.addItem(app)
        probe.addItem(window)
        probeItem.submenu = probe
        main.addItem(probeItem)
        NSApp.mainMenu = main
    }

    private func hit() {
        hits += 1
        hitCount.stringValue = "hits \(hits)"
    }

    private func ping(window: Bool) {
        if window { windowPings += 1 } else { appPings += 1 }
        pings.stringValue = "app \(appPings) window \(windowPings)"
    }

    @objc private func pingApp(_ sender: Any?) { ping(window: false) }

    @objc private func stepped(_ sender: NSStepper) { stepValue.stringValue = "value \(sender.integerValue)" }

    /// An in-process save panel as a sheet on the window, aimed at the run's scratch folder.
    @objc private func save(_ sender: Any?) {
        guard let window else { return }
        let panel = NSSavePanel()
        panel.directoryURL = URL(fileURLWithPath: scratch, isDirectory: true)
        panel.nameFieldStringValue = "Untitled.txt"
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { return }
            try? "saved by the fallbacks leg\n".write(to: url, atomically: true, encoding: .utf8)
        }
    }
}

UserDefaults.standard.register(defaults: ["ApplePersistenceIgnoreState": true])
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = ProbeDelegate()
app.delegate = delegate
app.run()
