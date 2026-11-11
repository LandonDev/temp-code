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
// `--fewer` (opt-in, for the fewer calls leg; §27): see ProbeFewer below.
// `--cover <x,y,w,h>` (field hand runs): one opaque normal-level window in global top-left points,
// ordered in front without becoming key or taking input; no other probe window opens.
//
// `--active <dir>` (opt-in, for the steps that need the app active; §26): see ProbeActive below. Its
// document and file list keep the app's rules: their File commands go down the responder chain, so they
// read disabled while the app is in the background, as TextEdit's and Finder's do.
//
// `TCProbeSteal` (an Info.plist key, set only in "TC Probe Steal.app", bundle id
// dev.landon.tempcode.computer-probe-steal, for the front guard's leg): the app takes the front the way a
// misbehaving app does, Launch Services opening its own bundle with `activates` (see `steal()`), once its
// window shows, once per opened
// document and each time Ping is pressed. It opens `.tcprobe` documents into a second inert window titled
// with the file's name. Its windows stay inert all the same, so a steal takes none of the person's keys.
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
    private let active = ProbeActive()
    private let fewer = ProbeFewer()
    private var documents: [NSWindow] = []
    /// the stealer's Info.plist says so
    private let steals = Bundle.main.object(forInfoDictionaryKey: "TCProbeSteal") as? Bool ?? false

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let at = CommandLine.arguments.firstIndex(of: "--cover") {
            guard at + 1 < CommandLine.arguments.count else { exit(2) }
            let parts = CommandLine.arguments[at + 1].split(separator: ",").compactMap { Double($0) }
            guard parts.count == 4, parts.allSatisfy({ $0.isFinite }), parts[2] > 0, parts[3] > 0 else { exit(2) }
            // Chrome's flags and CGWindowList use a top-left origin; AppKit uses bottom-left.
            let screenTop = NSScreen.screens.first?.frame.maxY ?? 0
            let cover = InertWindow(contentRect: NSRect(x: parts[0], y: screenTop - parts[1] - parts[3], width: parts[2], height: parts[3]), styleMask: [.borderless], backing: .buffered, defer: false)
            cover.title = "TC Probe Cover"
            cover.backgroundColor = .windowBackgroundColor
            cover.isOpaque = true
            cover.hasShadow = false
            cover.level = .normal
            cover.ignoresMouseEvents = true
            cover.isRestorable = false
            cover.isReleasedWhenClosed = false
            cover.orderFrontRegardless()
            self.window = cover
            return
        }
        if CommandLine.arguments.contains("--fewer") {
            fewer.open()
            return
        }
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
        steal()

        if CommandLine.arguments.contains("--windows") { windows.open() }
        if let at = CommandLine.arguments.firstIndex(of: "--fallbacks"), at + 1 < CommandLine.arguments.count {
            fallbacks.open(scratch: CommandLine.arguments[at + 1])
        }
        if let at = CommandLine.arguments.firstIndex(of: "--active"), at + 1 < CommandLine.arguments.count {
            active.open(scratch: CommandLine.arguments[at + 1])
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
        steal()
    }

    /// A `.tcprobe` document: a second inert window, titled with the file's name.
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.pathExtension == "tcprobe" {
            let document = InertWindow(
                contentRect: NSRect(x: 200, y: 200, width: 320, height: 120),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            document.title = url.lastPathComponent
            document.isReleasedWhenClosed = false
            document.isRestorable = false
            document.contentView = NSTextField(labelWithString: url.lastPathComponent)
            document.ignoresMouseEvents = true
            document.orderBack(nil)
            documents.append(document)
            steal()
        }
    }

    /// The stealer's activation, which the front guard puts back; the plain probe never activates.
    /// macOS 14 and later refuse `NSApp.activate(ignoringOtherApps:)` and `open -b` from an app in the
    /// background; asking Launch Services to open its own bundle with `activates` still takes the front
    /// (macOS 27.2, 2026-11-10), so that is what this misbehaving app does.
    private func steal() {
        guard steals else { return }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { _, _ in }
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { false }
    /// `--active` makes an NSDocumentController, and AppKit then asks for an untitled document at launch
    /// (or an open panel), which comes forward: the probe opens its own documents and none other.
    func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { false }
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
        let probe = NSMenu(title: "Probe")
        let app = NSMenuItem(title: "Ping App", action: #selector(pingApp(_:)), keyEquivalent: "p")
        app.keyEquivalentModifierMask = [.command, .shift]
        app.target = self
        let window = NSMenuItem(title: "Ping Window", action: #selector(FallbackContent.pingWindow(_:)), keyEquivalent: "k")
        window.keyEquivalentModifierMask = [.command, .shift]
        probe.addItem(app)
        probe.addItem(window)
        MenuBar.add(probe)
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

// MARK: --fewer

/// Return edits the selected row inline; AppKit's field editor commits on the next Return.
final class RenameTable: NSTableView {
    override func keyDown(with event: NSEvent) {
        if (event.keyCode == 36 || event.keyCode == 76), selectedRow >= 0, editedRow < 0 {
            editColumn(0, row: selectedRow, with: nil, select: true)
            return
        }
        super.keyDown(with: event)
    }
}

/// Standard AppKit controls for §27's single-call proofs. Key only inside its background app, like
/// --fallbacks: no activation, no mouse input from the person, and no saved documents or state.
final class ProbeFewer: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    private var window: NSWindow?
    private var notes: [NSWindow] = []
    private let table = RenameTable()
    private var names = ["Draft note", "Second note", "Third note"]

    func open() {
        installMenu()
        let window = makeWindow("TC Probe Fewer", height: 240)
        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        popup.addItems(withTitles: ["Personal", "Team", "Archive"])
        popup.setAccessibilityLabel("Destination")

        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
        column.title = "Notes"
        column.width = 320
        column.isEditable = true
        let cell = NSTextFieldCell(textCell: "")
        cell.isEditable = true
        column.dataCell = cell
        table.addTableColumn(column)
        table.headerView = nil
        table.rowHeight = 28
        table.frame = NSRect(x: 0, y: 0, width: 320, height: 84)
        table.autoresizingMask = [.width]
        table.allowsEmptySelection = true
        table.allowsMultipleSelection = false
        table.dataSource = self
        table.delegate = self
        table.setAccessibilityLabel("Notes")
        table.reloadData()
        table.deselectAll(nil)
        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.translatesAutoresizingMaskIntoConstraints = false

        // AXPress succeeds and leaves the tree unchanged, a deliberate test of §27.8.
        let unchanged = NSButton(title: "No Change", target: self, action: #selector(noChange(_:)))
        // a press that changes nothing draws nothing either: AppKit's pressed flash is a pixel change the wait counts
        if let cell = unchanged.cell as? NSButtonCell {
            cell.highlightsBy = []
            cell.showsStateBy = []
        }
        let stack = NSStackView(views: [popup, scroll, unchanged])
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
            popup.widthAnchor.constraint(equalToConstant: 320),
            scroll.widthAnchor.constraint(equalToConstant: 320),
            scroll.heightAnchor.constraint(equalToConstant: 100),
        ])
        window.contentView = content
        window.orderBack(nil)
        window.makeKey()
        self.window = window
    }

    private func makeWindow(_ title: String, height: CGFloat) -> NSWindow {
        let window = KeyableWindow(contentRect: NSRect(x: 560, y: 360, width: 360, height: height), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = title
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.ignoresMouseEvents = true
        return window
    }

    private func installMenu() {
        let probe = NSMenu(title: "Probe")
        let newNote = NSMenuItem(title: "New Note", action: #selector(newNote(_:)), keyEquivalent: "n")
        newNote.keyEquivalentModifierMask = [.command, .shift]
        newNote.target = self
        probe.addItem(newNote)
        MenuBar.add(probe)
    }

    @objc private func newNote(_ sender: Any?) {
        let note = makeWindow("TC Probe Note", height: 180)
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 360, height: 180))
        text.isRichText = false
        text.font = .systemFont(ofSize: 13)
        text.textContainerInset = NSSize(width: 16, height: 16)
        text.setAccessibilityLabel("Note")
        note.contentView = text
        note.orderBack(nil)
        note.makeKey()
        note.makeFirstResponder(text)
        notes.append(note)
    }

    @objc private func noChange(_ sender: Any?) {}

    func numberOfRows(in tableView: NSTableView) -> Int { names.count }

    func tableView(_ tableView: NSTableView, objectValueFor tableColumn: NSTableColumn?, row: Int) -> Any? {
        names[row]
    }

    func tableView(_ tableView: NSTableView, setObjectValue object: Any?, for tableColumn: NSTableColumn?, row: Int) {
        guard let name = object as? String else { return }
        names[row] = name
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        // AXSelectedRows follows the same path as a mouse selection, including keyboard focus.
        if table.selectedRow >= 0 { window?.makeFirstResponder(table) }
    }
}

// MARK: the menu bar

/// The menu bar the modes share: an app menu with Quit, then each mode's menus in the order they open.
/// The plain probe opens none and has no menu bar of its own.
enum MenuBar {
    static func add(_ menu: NSMenu) {
        let bar = NSApp.mainMenu ?? {
            let bar = NSMenu()
            let appMenu = NSMenu()
            appMenu.addItem(withTitle: "Quit TC Probe", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            let appItem = NSMenuItem()
            appItem.submenu = appMenu
            bar.addItem(appItem)
            NSApp.mainMenu = bar
            return bar
        }()
        let item = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
        item.submenu = menu
        bar.addItem(item)
    }

    /// An item with no target: AppKit sends it down the responder chain from the key window, so it reads
    /// disabled while the app is in the background (§26.1).
    static func chain(_ title: String, _ action: Selector, _ key: String, _ modifiers: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        return item
    }
}

// MARK: --active

/// The probe keeps no recent documents. It must be made before anything reads `NSDocumentController.shared`.
final class ProbeDocumentController: NSDocumentController {
    override func noteNewRecentDocumentURL(_ url: URL) {}
    override var maximumRecentDocumentCount: Int { 0 }
}

/// A plain-text document that saves in place, as TextEdit's does. Save, Save As…, the edited flag (the
/// close button's AXEdited), the window's AXDocument and the save panel are all AppKit's own.
final class ProbeTextDocument: NSDocument, NSTextViewDelegate {
    static let type = "public.plain-text"
    private var text = ""
    private var view: NSTextView?

    override class var autosavesInPlace: Bool { true }
    override class var readableTypes: [String] { [type] }
    override class var writableTypes: [String] { [type] }
    override class func isNativeType(_ name: String) -> Bool { name == type }
    override func writableTypes(for saveOperation: NSDocument.SaveOperationType) -> [String] { [Self.type] }
    override func fileNameExtension(forType typeName: String, saveOperation: NSDocument.SaveOperationType) -> String? { "txt" }

    override func makeWindowControllers() {
        let window = KeyableWindow(
            contentRect: NSRect(x: 560, y: 420, width: 420, height: 240),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.isRestorable = false
        window.ignoresMouseEvents = true
        let scroll = NSTextView.scrollableTextView()
        if let view = scroll.documentView as? NSTextView {
            view.string = text
            view.isRichText = false
            view.delegate = self
            view.setAccessibilityLabel("Text")
            self.view = view
        }
        window.contentView = scroll
        addWindowController(NSWindowController(window: window))
    }

    override func data(ofType typeName: String) throws -> Data { Data((view?.string ?? text).utf8) }

    override func read(from data: Data, ofType typeName: String) throws {
        text = String(decoding: data, as: UTF8.self)
        view?.string = text
    }

    var textView: NSTextView? { view }

    func textDidChange(_ notification: Notification) { updateChangeCount(.changeDone) }
}

/// A file or folder under `<scratch>/files`.
final class FileRow: NSObject {
    let url: URL
    init(url: URL) { self.url = url }
    var name: String { url.lastPathComponent }
}

/// A row's name, edited in place as Finder's is. An accessibility write puts the name on screen and opens
/// the field editor on it; the file keeps its old name until the editor ends (Return or Tab) while the app
/// is active. In the background Return goes nowhere, so a write alone is on screen only (finding 1).
final class RenameField: NSTextField {
    var row: FileRow?

    override func setAccessibilityValue(_ value: Any?) {
        guard let name = value as? String else { return super.setAccessibilityValue(value) }
        stringValue = name
        if currentEditor() == nil { window?.makeFirstResponder(self) }
    }
}

/// The file list, in the responder chain of its window: File › New Folder and File › Move to Trash land
/// here only while the window is key, which an inactive app's never is.
final class FileOutline: NSOutlineView {
    var onNewFolder: () -> Void = {}
    var onTrash: () -> Void = {}

    @objc func newFolder(_ sender: Any?) { onNewFolder() }
    @objc func moveToTrash(_ sender: Any?) { onTrash() }

    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(moveToTrash(_:)) { return selectedRow >= 0 }
        if item.action == #selector(newFolder(_:)) { return true }
        return super.validateUserInterfaceItem(item)
    }
}

/// `--active <scratch>`: the document window on `<scratch>/doc.txt` and the file list "files" over
/// `<scratch>/files`, whose rows carry AXURL and whose window's AXDocument is the folder, with a "Sort"
/// pop-up above it. The File menu
/// holds the document's commands (Save ⌘S, Save As… ⇧⌘S, Rename…, Move To…, Revert To Saved, Close ⌘W)
/// and the list's (New Folder ⇧⌘N, Move to Trash ⌘⌫, into `<scratch>/Trash`, never the real Trash), all
/// with no target. Both windows are ordered back and mouse-inert; the app never activates itself.
final class ProbeActive: NSObject, NSOutlineViewDataSource, NSOutlineViewDelegate, NSTextFieldDelegate {
    private var scratch = URL(fileURLWithPath: "/")
    private var files: URL { scratch.appendingPathComponent("files", isDirectory: true) }
    private var trash: URL { scratch.appendingPathComponent("Trash", isDirectory: true) }
    private var rows: [FileRow] = []
    private var list: FileOutline?
    private var document: ProbeTextDocument?

    func open(scratch path: String) {
        scratch = URL(fileURLWithPath: path, isDirectory: true)
        let fm = FileManager.default
        try? fm.createDirectory(at: files, withIntermediateDirectories: true)
        try? fm.createDirectory(at: trash, withIntermediateDirectories: true)
        let doc = scratch.appendingPathComponent("doc.txt")
        if !fm.fileExists(atPath: doc.path) { try? "TC Probe document\n".write(to: doc, atomically: true, encoding: .utf8) }
        if (try? fm.contentsOfDirectory(atPath: files.path))?.isEmpty ?? true {
            for name in ["alpha.txt", "beta.txt"] {
                try? "\(name)\n".write(to: files.appendingPathComponent(name), atomically: true, encoding: .utf8)
            }
        }
        installMenus()
        openList()
        openDocument(doc)
    }

    private func installMenus() {
        let file = NSMenu(title: "File")
        file.addItem(MenuBar.chain("New Folder", #selector(FileOutline.newFolder(_:)), "n", [.command, .shift]))
        file.addItem(.separator())
        file.addItem(MenuBar.chain("Close", #selector(NSWindow.performClose(_:)), "w"))
        file.addItem(MenuBar.chain("Save", #selector(NSDocument.save(_:)), "s"))
        file.addItem(MenuBar.chain("Save As…", #selector(NSDocument.saveAs(_:)), "s", [.command, .shift]))
        file.addItem(MenuBar.chain("Rename…", #selector(NSDocument.rename(_:)), ""))
        file.addItem(MenuBar.chain("Move To…", #selector(NSDocument.move(_:)), ""))
        file.addItem(MenuBar.chain("Revert To Saved", #selector(NSDocument.revertToSaved(_:)), ""))
        file.addItem(.separator())
        file.addItem(MenuBar.chain("Move to Trash", #selector(FileOutline.moveToTrash(_:)), "\u{8}"))
        MenuBar.add(file)
        let edit = NSMenu(title: "Edit")
        edit.addItem(MenuBar.chain("Cut", #selector(NSText.cut(_:)), "x"))
        edit.addItem(MenuBar.chain("Copy", #selector(NSText.copy(_:)), "c"))
        edit.addItem(MenuBar.chain("Paste", #selector(NSText.paste(_:)), "v"))
        edit.addItem(MenuBar.chain("Select All", #selector(NSText.selectAll(_:)), "a"))
        MenuBar.add(edit)
    }

    private func openDocument(_ url: URL) {
        guard let doc = try? ProbeTextDocument(contentsOf: url, ofType: ProbeTextDocument.type) else { return }
        NSDocumentController.shared.addDocument(doc)
        doc.makeWindowControllers()
        guard let window = doc.windowControllers.first?.window else { return }
        // ordered back and key in its app, the app still in the background: no activate, no showWindows
        window.orderBack(nil)
        window.makeKey()
        if let view = doc.textView { window.makeFirstResponder(view) }
        document = doc
    }

    private func openList() {
        let window = KeyableWindow(contentRect: NSRect(x: 1_000, y: 420, width: 360, height: 240), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "files"
        window.representedURL = files
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        let outline = FileOutline()
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
        column.title = "Name"
        outline.addTableColumn(column)
        outline.outlineTableColumn = column
        outline.headerView = nil
        outline.dataSource = self
        outline.delegate = self
        outline.setAccessibilityLabel("Files")
        outline.onNewFolder = { [weak self] in self?.newFolder() }
        outline.onTrash = { [weak self] in self?.moveSelectedToTrash() }
        let scroll = NSScrollView()
        scroll.documentView = outline
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        // a pop-up whose menu AXPress opens in the background, unseen (E2'): the menu-closing leg's
        let sort = NSPopUpButton(frame: .zero, pullsDown: false)
        sort.addItems(withTitles: ["Name", "Date"])
        sort.setAccessibilityLabel("Sort")
        let stack = NSStackView(views: [sort, scroll])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.edgeInsets = NSEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        NSLayoutConstraint.activate([
            scroll.widthAnchor.constraint(equalToConstant: 340),
            scroll.heightAnchor.constraint(equalToConstant: 180),
        ])
        window.contentView = stack
        window.ignoresMouseEvents = true
        list = outline
        reload()
        window.orderBack(nil)
        window.makeFirstResponder(outline)
    }

    private func reload(select name: String? = nil) {
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: files.path)) ?? []).filter { !$0.hasPrefix(".") }.sorted()
        rows = names.map { FileRow(url: files.appendingPathComponent($0)) }
        list?.reloadData()
        if let name, let at = rows.firstIndex(where: { $0.name == name }) {
            list?.selectRowIndexes(IndexSet(integer: at), byExtendingSelection: false)
        }
    }

    /// Finder's New Folder: "untitled folder" on disk at once, selected, its name open for editing.
    private func newFolder() {
        var name = "untitled folder"
        var n = 2
        while FileManager.default.fileExists(atPath: files.appendingPathComponent(name).path) {
            name = "untitled folder \(n)"
            n += 1
        }
        guard (try? FileManager.default.createDirectory(at: files.appendingPathComponent(name), withIntermediateDirectories: false)) != nil else { return }
        reload(select: name)
        if let list, let at = rows.firstIndex(where: { $0.name == name }) { list.editColumn(0, row: at, with: nil, select: true) }
    }

    /// Move to Trash: the selected rows into `<scratch>/Trash`, a number added where the name is taken.
    private func moveSelectedToTrash() {
        guard let list else { return }
        for at in list.selectedRowIndexes where at < rows.count {
            let from = rows[at].url
            var to = trash.appendingPathComponent(from.lastPathComponent)
            var n = 2
            while FileManager.default.fileExists(atPath: to.path) {
                to = trash.appendingPathComponent("\(from.deletingPathExtension().lastPathComponent) \(n)" + (from.pathExtension.isEmpty ? "" : ".\(from.pathExtension)"))
                n += 1
            }
            try? FileManager.default.moveItem(at: from, to: to)
        }
        reload()
    }

    // MARK: the outline

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int { item == nil ? rows.count : 0 }
    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any { rows[index] }
    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool { false }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let row = item as? FileRow else { return nil }
        let cell = NSTableCellView()
        let field = RenameField(string: row.name)
        field.row = row
        field.isBordered = false
        field.drawsBackground = false
        field.isEditable = true
        field.delegate = self
        field.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(field)
        cell.textField = field
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 4),
            field.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -4),
            field.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        cell.setAccessibilityURL(row.url)
        return cell
    }

    func outlineView(_ outlineView: NSOutlineView, rowViewForItem item: Any) -> NSTableRowView? {
        let view = NSTableRowView()
        if let row = item as? FileRow { view.setAccessibilityURL(row.url) }
        return view
    }

    // MARK: the inline name

    /// Return and Tab end the edit only in the active app; in the background they go nowhere.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)) || commandSelector == #selector(NSResponder.insertTab(_:)) {
            return !NSApp.isActive
        }
        return false
    }

    /// The edit's end commits the name to disk (the inode kept), unless it was cancelled, the app is in the
    /// background, or the name is empty, holds a slash or is taken; then the row shows the name on disk again.
    func controlTextDidEndEditing(_ notification: Notification) {
        guard let field = notification.object as? RenameField, let row = field.row else { return }
        let movement = (notification.userInfo?["NSTextMovement"] as? Int).flatMap(NSTextMovement.init(rawValue:))
        let name = field.stringValue
        let to = files.appendingPathComponent(name)
        let commit = NSApp.isActive && movement != .cancel && !name.isEmpty && !name.contains("/") && name != row.name
            && !FileManager.default.fileExists(atPath: to.path)
        if commit, (try? FileManager.default.moveItem(at: row.url, to: to)) != nil {
            DispatchQueue.main.async { self.reload(select: name) }
        } else {
            field.stringValue = row.name
        }
    }
}

UserDefaults.standard.register(defaults: ["ApplePersistenceIgnoreState": true])
if CommandLine.arguments.contains("--active") { _ = ProbeDocumentController() }
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = ProbeDelegate()
app.delegate = delegate
app.run()
