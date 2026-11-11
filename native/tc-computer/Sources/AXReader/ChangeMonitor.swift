#if canImport(ApplicationServices)
import ApplicationServices
import AXText
import ComputerCore
import ComputerProtocol
import Foundation
import os

/// The one thread every reader's AXObserver runs on, so the reader never needs
/// the shell's main run loop (plan §5.5).
final class AXObserverThread: Thread, @unchecked Sendable {
    static let shared: AXObserverThread = {
        let t = AXObserverThread()
        t.name = "tc-computer.ax-observer"
        t.start()
        t.ready.wait()
        return t
    }()

    private let ready = DispatchSemaphore(value: 0)
    private var loop: CFRunLoop?

    override func main() {
        loop = CFRunLoopGetCurrent()
        // a timer that never fires keeps the run loop running with no observer yet
        let keep = CFRunLoopTimerCreateWithHandler(nil, .greatestFiniteMagnitude, 0, 0, 0) { _ in }
        CFRunLoopAddTimer(loop, keep, .defaultMode)
        ready.signal()
        CFRunLoopRun()
    }

    func add(_ source: CFRunLoopSource) {
        CFRunLoopAddSource(loop, source, .defaultMode)
        CFRunLoopWakeUp(loop)
    }

    func remove(_ source: CFRunLoopSource) {
        CFRunLoopRemoveSource(loop, source, .defaultMode)
    }
}

/// The smart wait's signals on one app (spec §7): the time of the last AX
/// notification, the shallow signature, and whether a busy indicator shows.
final class ChangeMonitor: ChangeSignal, @unchecked Sendable {
    /// Spec §7's notifications, plus AXLoadComplete for the busy candidates (A11).
    static let notifications: [String] = [
        kAXValueChangedNotification, kAXTitleChangedNotification, kAXCreatedNotification, kAXUIElementDestroyedNotification,
        kAXLayoutChangedNotification, kAXFocusedUIElementChangedNotification, kAXSelectedTextChangedNotification,
        kAXSelectedChildrenChangedNotification, kAXMenuOpenedNotification, kAXMenuClosedNotification, kAXWindowCreatedNotification,
        kAXWindowMovedNotification, kAXWindowResizedNotification, kAXWindowMiniaturizedNotification, kAXWindowDeminiaturizedNotification,
        "AXElementBusyChanged", "AXLoadComplete"
    ]
    /// The ones that name an element that may be a new busy candidate.
    static let candidateNotifications: Set<String> = [kAXCreatedNotification, "AXElementBusyChanged", "AXLoadComplete"]

    struct Candidate {
        let element: AXUIElement
        let kind: BusyRule.Kind
        let containers: [AXUIElement]
    }

    let app: AXUIElement
    private let last = OSAllocatedUnfairLock(initialState: UInt64(0))
    private let lock = NSLock()
    private var observer: AXObserver?
    private var window: AXUIElement?
    private var scrollAreas: [AXUIElement] = []
    private var candidates: [Candidate] = []
    /// `lastChange` when the web areas were last scanned (A11's busy scan)
    private var scannedAt: UInt64 = 0
    /// notifications the app element refused, registered on the window instead
    private var onWindow: [String] = []
    /// the window's direct children read once each: true for its title-bar buttons and the sharing
    /// badge, which the signature and the clock never count (§22.8); forgotten with the window
    private var chrome: [ElementKey: Bool] = [:]
    /// the window's frame and its buttons' frames when last read, for the badge rule of a created element
    private var chromeFrames: (window: ComputerProtocol.Rect?, buttons: [ComputerProtocol.Rect]) = (nil, [])
    /// §27.4: the call's menus opened and windows and sheets created, by step; §26's menu record too
    private var record = CallRecord<AXUIElement>()

    init(pid: pid_t, app: AXUIElement) {
        self.app = app
        var made: AXObserver?
        let callback: AXObserverCallback = { _, element, notification, refcon in
            guard let refcon else { return }
            Unmanaged<ChangeMonitor>.fromOpaque(refcon).takeUnretainedValue().heard(element, notification as String)
        }
        guard AXObserverCreate(pid, callback, &made) == .success, let made else { return }
        observer = made
        let me = Unmanaged.passUnretained(self).toOpaque()
        for n in Self.notifications {
            let e = AXObserverAddNotification(made, app, n as CFString, me)
            if e != .success && e != .notificationAlreadyRegistered { onWindow.append(n) }
        }
        AXObserverThread.shared.add(AXObserverGetRunLoopSource(made))
    }

    var lastChange: UInt64 { last.withLock { $0 } }

    /// A notification: the clock moves, and an element that may be a busy indicator joins the candidates.
    /// One whose element is the window's title-bar chrome (a button, the capture's badge) moves nothing (§22.8).
    func heard(_ element: AXUIElement, _ notification: String) {
        if isChrome(element, created: notification == kAXCreatedNotification) { return }
        let t = mach_absolute_time()
        last.withLock { $0 = t }
        noteOpened(element, notification)
        guard Self.candidateNotifications.contains(notification), let role = AX.string(AX.copy(element, "AXRole").value) else { return }
        let kind: BusyRule.Kind? = role == "AXBusyIndicator" ? .busy : role == "AXProgressIndicator" ? .progress : role == "AXWebArea" ? .webArea : nil
        guard let kind else { return }
        // its containers, followed up to the window once on arrival
        var containers: [AXUIElement] = []
        var up = AX.element(AX.copy(element, "AXParent").value)
        var steps = 0
        while let p = up, steps < 64 {
            steps += 1
            let r = AX.string(AX.copy(p, "AXRole").value) ?? ""
            if r == "AXWindow" || r == "AXApplication" { break }
            if Viewport.clipRoles.contains(r) { containers.insert(p, at: 0) }
            up = AX.element(AX.copy(p, "AXParent").value)
        }
        lock.lock()
        if !candidates.contains(where: { CFEqual($0.element, element) }) {
            candidates.append(Candidate(element: element, kind: kind, containers: Array(containers.suffix(8))))
        }
        lock.unlock()
    }

    /// §27.4: a menu that opened, a window or a sheet created, while a step of a call records.
    private func noteOpened(_ element: AXUIElement, _ notification: String) {
        lock.lock()
        let recording = record.step != nil
        if notification == kAXMenuClosedNotification { record.closed(element) { CFEqual($0, $1) } }
        lock.unlock()
        guard recording else { return }
        let kind: CallRecord<AXUIElement>.Kind?
        switch notification {
        case kAXMenuOpenedNotification: kind = .menu
        case kAXWindowCreatedNotification: kind = .window
        // there is no AXSheetCreated: a sheet comes as AXCreated
        case kAXCreatedNotification: kind = AX.string(AX.copy(element, "AXRole").value) == "AXSheet" ? .sheet : nil
        default: kind = nil
        }
        guard let kind else { return }
        lock.lock()
        record.note(kind, element) { CFEqual($0, $1) }
        lock.unlock()
    }

    func beginCall() {
        lock.lock()
        record.begin()
        lock.unlock()
    }

    func recordStep(_ index: Int) {
        lock.lock()
        record.record(step: index)
        lock.unlock()
    }

    func endCall() {
        lock.lock()
        record.end()
        lock.unlock()
    }

    /// Whether something opened during step `index` of the call (§27.4).
    func opened(during index: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return record.opened(during: index)
    }

    /// What the call's steps opened so far.
    func recorded() -> [CallRecord<AXUIElement>.Entry] {
        lock.lock()
        defer { lock.unlock() }
        return record.entries
    }

    /// What the last walk showed: the window, its scroll areas, its busy candidates.
    func noteWalk(_ notes: WalkNotes, window w: AXUIElement) {
        lock.lock()
        defer { lock.unlock() }
        if let observer, !onWindow.isEmpty, window.map({ !CFEqual($0, w) }) ?? true {
            let me = Unmanaged.passUnretained(self).toOpaque()
            for n in onWindow {
                if let old = window { AXObserverRemoveNotification(observer, old, n as CFString) }
                AXObserverAddNotification(observer, w, n as CFString, me)
            }
        }
        if window.map({ !CFEqual($0, w) }) ?? true { chrome = [:] }
        window = w
        scrollAreas = notes.scrollAreas
        candidates = notes.busy.map { Candidate(element: $0.element, kind: $0.kind, containers: $0.containers) }
    }

    /// A tab switch's window (§25.2): its page is a busy candidate until the next walk says what it holds.
    func watchPage(_ window: AXUIElement) {
        lock.lock()
        if !candidates.contains(where: { $0.kind == .pageMissing && CFEqual($0.element, window) }) {
            candidates.append(Candidate(element: window, kind: .pageMissing, containers: []))
        }
        lock.unlock()
    }

    /// Spec §7's parts, never a walk: the focused element, its value and
    /// selection, the window's title, its children's identities, and the child
    /// counts of the window and the scroll areas last shown (A7's limits).
    func signature() -> UInt64 {
        lock.lock()
        let w = window
        let areas = scrollAreas
        lock.unlock()
        let focused = AX.element(AX.copy(app, "AXFocusedUIElement").value)
        var value: String?
        var length: Int?
        var selection: [Int]?
        if let f = focused {
            let b = AX.batch(f, ["AXNumberOfCharacters", "AXSelectedTextRange"])
            length = AX.int(b["AXNumberOfCharacters"]?.value)
            selection = AX.range(b["AXSelectedTextRange"]?.value)
            if (length ?? 0) <= Signature.maxValueUnits {
                switch AX.scalar(AX.copy(f, "AXValue").value) {
                case .string(let s)?, .number(let s)?: value = s
                case .bool(let b)?: value = b ? "1" : "0"
                default: value = nil
                }
            }
        }
        var title: String?
        var minimized: Bool?
        var children: [UInt64] = []
        var counts: [Int] = []
        if let w {
            let b = AX.batch(w, ["AXTitle", "AXChildren", "AXMinimized"] + TitleBar.attributes)
            title = AX.string(b["AXTitle"]?.value)
            minimized = AX.bool(b["AXMinimized"]?.value)
            // the children without the title-bar buttons and the sharing badge, so a capture starting is no change (§22.8)
            let kids = content(AX.elements(b["AXChildren"]?.value), buttons: TitleBar.attributes.compactMap { AX.element(b[$0]?.value) }, window: w)
            children = kids.map { UInt64(CFHash($0)) }
            counts.append(kids.count)
        }
        counts += areas.prefix(Signature.maxScrollAreas).map { AX.count($0, "AXChildren") ?? -1 }
        return Signature(focused: focused.map { UInt64(CFHash($0)) }, value: value, valueLength: length, selection: selection,
                         title: title, minimized: minimized, windowChildren: children, counts: counts).hash
    }

    /// One child as the badge rule reads it.
    private static func child(_ el: AXUIElement) -> TitleBar.Child {
        let b = AX.batch(el, ["AXRole", "AXSubrole", "AXPosition", "AXSize"])
        return TitleBar.Child(role: AX.string(b["AXRole"]?.value) ?? "", subrole: AX.string(b["AXSubrole"]?.value), frame: AX.frame(b["AXPosition"]?.value, b["AXSize"]?.value))
    }

    private static func frame(_ el: AXUIElement) -> ComputerProtocol.Rect? {
        let b = AX.batch(el, ["AXPosition", "AXSize"])
        return AX.frame(b["AXPosition"]?.value, b["AXSize"]?.value)
    }

    /// The window's children less its chrome: a button the window's attributes name is chrome; any
    /// other child not seen at an earlier sample is read once and remembered as the badge or not.
    private func content(_ kids: [AXUIElement], buttons: [AXUIElement], window w: AXUIElement) -> [AXUIElement] {
        lock.lock()
        for b in buttons { chrome[ElementKey(element: b)] = true }
        let unread = kids.filter { chrome[ElementKey(element: $0)] == nil }
        lock.unlock()
        if !unread.isEmpty {
            // read outside the lock: the observer thread takes it for every notification
            let frames = (window: Self.frame(w), buttons: buttons.compactMap(Self.frame))
            let read = unread.map { (ElementKey(element: $0), TitleBar.isSharingBadge(Self.child($0), window: frames.window, buttons: frames.buttons)) }
            lock.lock()
            chromeFrames = frames
            for (key, badge) in read { chrome[key] = badge }
            // a window whose children churn (Electron) stays bounded: past 512, only what this sample holds is kept
            if chrome.count > 512 {
                let now = Set((kids + buttons).map(ElementKey.init))
                chrome = chrome.filter { now.contains($0.key) }
            }
            lock.unlock()
        }
        lock.lock()
        defer { lock.unlock() }
        return kids.filter { chrome[ElementKey(element: $0)] != true }
    }

    /// Whether a notification's element is the window's chrome: one remembered, or, for a created
    /// element, a direct child of the window the rule names a title-bar button or the badge (read once).
    private func isChrome(_ element: AXUIElement, created: Bool) -> Bool {
        lock.lock()
        let known = chrome[ElementKey(element: element)]
        let w = window
        let frames = chromeFrames
        lock.unlock()
        if let known { return known }
        guard created, let w, let parent = AX.element(AX.copy(element, "AXParent").value), CFEqual(parent, w) else { return false }
        let c = Self.child(element)
        let isChrome = TitleBar.isButton(subrole: c.subrole) || TitleBar.isSharingBadge(c, window: frames.window, buttons: frames.buttons)
        lock.lock()
        chrome[ElementKey(element: element)] = isChrome
        lock.unlock()
        return isChrome
    }

    /// A busy indicator, an indeterminate progress, a busy web area or a selected tab with no page that shows now
    /// (spec §7, A11): each candidate and its containers read again, the clip made from their frames now;
    /// with none showing and the app changed since the last scan, the web areas are scanned for a new one.
    func busyIndicatorShowing() -> Bool {
        lock.lock()
        let list = candidates
        let w = window
        lock.unlock()
        let frameOf = { (el: AXUIElement) -> ComputerProtocol.Rect? in
            let b = AX.batch(el, ["AXPosition", "AXSize"])
            return AX.frame(b["AXPosition"]?.value, b["AXSize"]?.value)
        }
        let windowFrame = w.flatMap(frameOf)
        /// nil: the element is gone
        func shows(_ c: Candidate) -> Bool? {
            let a = AX.batch(c.element, ["AXRole", "AXValue", "AXElementBusy", "AXLoaded", "AXPosition", "AXSize"])
            if case .gone? = a["AXRole"] { return nil }
            // a browser window whose selected tab had no page (§25.2): its strip and top-level web areas read again
            if c.kind == .pageMissing {
                // loaded: the selected tab's page is there and done; a page found but still loading holds too
                let page = LiveTabs.reading(c.element, ids: HandleTable(capacity: 64)).map { $0.0.state(waitedOut: false) == .loaded } ?? true
                return BusyRule.showing(.pageMissing, frame: nil, hasValue: false, busy: nil, loaded: page, clips: [])
            }
            let clips = [windowFrame].compactMap { $0 } + c.containers.compactMap(frameOf)
            let hasValue: Bool = {
                switch AX.scalar(a["AXValue"]?.value) {
                case .string(let s)?: !s.isEmpty
                case .number?, .bool?: true
                default: false
                }
            }()
            return BusyRule.showing(c.kind, frame: AX.frame(a["AXPosition"]?.value, a["AXSize"]?.value), hasValue: hasValue,
                                    busy: AX.bool(a["AXElementBusy"]?.value), loaded: AX.bool(a["AXLoaded"]?.value), clips: clips)
        }
        var alive: [Candidate] = []
        var showing = false
        for c in list {
            guard let s = shows(c) else { continue }
            alive.append(c)
            showing = showing || s
        }
        var found: [Candidate] = []
        let change = lastChange
        lock.lock()
        let scan = !showing && change != scannedAt
        if scan { scannedAt = change }
        lock.unlock()
        if scan {
            let start = DispatchTime.now().uptimeNanoseconds
            var budget = BusyScan.maxNodes
            for area in alive where area.kind == .webArea && budget > 0 {
                let clip = ([windowFrame].compactMap { $0 } + area.containers.compactMap(frameOf)).reduce(nil as ComputerProtocol.Rect?) { Viewport.intersect($0, $1) }
                var read = 0
                let hits = BusyScan.find(root: area.element, clip: clip, maxNodes: budget,
                                         stop: { Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6 > BusyScan.maxMs }) { el in
                    read += 1
                    let b = AX.batch(el, ["AXRole", "AXPosition", "AXSize", "AXChildren"])
                    return BusyScan.Read(role: AX.string(b["AXRole"]?.value), frame: AX.frame(b["AXPosition"]?.value, b["AXSize"]?.value), children: AX.elements(b["AXChildren"]?.value))
                }
                budget -= read
                for h in hits where !alive.contains(where: { CFEqual($0.element, h.node) }) && !found.contains(where: { CFEqual($0.element, h.node) }) {
                    let c = Candidate(element: h.node, kind: h.kind, containers: Array((area.containers + h.containers).suffix(8)))
                    found.append(c)
                    showing = showing || (shows(c) ?? false)
                }
            }
        }
        lock.lock()
        // a candidate that answered invalid leaves the list; one the scan found joins it
        candidates.removeAll { c in !alive.contains { CFEqual($0.element, c.element) } && list.contains { CFEqual($0.element, c.element) } }
        candidates += found.filter { f in !candidates.contains { CFEqual($0.element, f.element) } }
        lock.unlock()
        return showing
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        guard let observer else { return }
        for n in Self.notifications { AXObserverRemoveNotification(observer, app, n as CFString) }
        if let w = window { for n in onWindow { AXObserverRemoveNotification(observer, w, n as CFString) } }
        AXObserverThread.shared.remove(AXObserverGetRunLoopSource(observer))
        self.observer = nil
    }
}
#endif
