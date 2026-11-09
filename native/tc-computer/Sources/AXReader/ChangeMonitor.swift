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
        kAXWindowMovedNotification, kAXWindowResizedNotification, "AXElementBusyChanged", "AXLoadComplete"
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
    /// notifications the app element refused, registered on the window instead
    private var onWindow: [String] = []

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
    func heard(_ element: AXUIElement, _ notification: String) {
        let t = mach_absolute_time()
        last.withLock { $0 = t }
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
        window = w
        scrollAreas = notes.scrollAreas
        candidates = notes.busy.map { Candidate(element: $0.element, kind: $0.kind, containers: $0.containers) }
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
        var children: [UInt64] = []
        var counts: [Int] = []
        if let w {
            let b = AX.batch(w, ["AXTitle", "AXChildren"])
            title = AX.string(b["AXTitle"]?.value)
            let kids = AX.elements(b["AXChildren"]?.value)
            children = kids.map { UInt64(CFHash($0)) }
            counts.append(kids.count)
        }
        counts += areas.prefix(Signature.maxScrollAreas).map { AX.count($0, "AXChildren") ?? -1 }
        return Signature(focused: focused.map { UInt64(CFHash($0)) }, value: value, valueLength: length, selection: selection,
                         title: title, windowChildren: children, counts: counts).hash
    }

    /// A busy indicator, an indeterminate progress or a busy web area that shows now
    /// (spec §7, A11): each candidate and its containers read again, the clip made from their frames now.
    func busyIndicatorShowing() -> Bool {
        lock.lock()
        let list = candidates
        let w = window
        lock.unlock()
        var alive: [Candidate] = []
        var showing = false
        let frameOf = { (el: AXUIElement) -> ComputerProtocol.Rect? in
            let b = AX.batch(el, ["AXPosition", "AXSize"])
            return AX.frame(b["AXPosition"]?.value, b["AXSize"]?.value)
        }
        let windowFrame = w.flatMap(frameOf)
        for c in list {
            let a = AX.batch(c.element, ["AXRole", "AXValue", "AXElementBusy", "AXLoaded", "AXPosition", "AXSize"])
            if case .gone? = a["AXRole"] { continue }
            alive.append(c)
            if showing { continue }
            let clips = [windowFrame].compactMap { $0 } + c.containers.compactMap(frameOf)
            let hasValue: Bool = {
                switch AX.scalar(a["AXValue"]?.value) {
                case .string(let s)?: !s.isEmpty
                case .number?, .bool?: true
                default: false
                }
            }()
            showing = BusyRule.showing(c.kind, frame: AX.frame(a["AXPosition"]?.value, a["AXSize"]?.value), hasValue: hasValue,
                                       busy: AX.bool(a["AXElementBusy"]?.value), loaded: AX.bool(a["AXLoaded"]?.value), clips: clips)
        }
        lock.lock()
        // a candidate that answered invalid leaves the list
        candidates.removeAll { c in !alive.contains { CFEqual($0.element, c.element) } && list.contains { CFEqual($0.element, c.element) } }
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
