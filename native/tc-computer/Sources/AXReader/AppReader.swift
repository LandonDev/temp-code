#if canImport(ApplicationServices)
import AppKit
import ApplicationServices
import AXText
import ComputerCore
import ComputerProtocol
import Foundation

/// The AX reader of one session × pid (spec §11 `AppReading`, plan §5.4). An
/// internal lock serializes observe, resolve and close.
public final class AppReader: AppReading, @unchecked Sendable {
    public let pid: pid_t
    let app: AXUIElement
    let book: IndexBook
    let handles: HandleTable
    let manual: ManualAccessibility
    let resolver: WindowResolver
    let monitor: ChangeMonitor
    private let lock = NSLock()
    private var base: Base?
    private var closed = false
    /// what the last walk counted and how long it and the build took, for `tc-ax bench`
    private(set) var lastCounts = WalkCounts()
    private(set) var lastProcess: ManualAccessibility.Process?
    public private(set) var lastWalkMs = 0.0
    public private(set) var lastBuildMs = 0.0
    /// The last window read's page (§25.2): its selected tab and state; nil for a window with no tab strip,
    /// a process that is not Chromium, or an element read. The ComputerService puts it on `Observation.page`.
    public private(set) var lastPage: Page?
    /// the last window read's lines by index, for `brief(of:)` (§25.9's `focus_moved`)
    private var lastBriefs: [Int: String] = [:]

    /// The last walk's nodes read, AX calls, attributes asked and stage-C calls.
    public var lastWalk: (nodes: Int, calls: Int, attributes: Int, stageC: Int) {
        (lastCounts.nodes, lastCounts.calls, lastCounts.attributes, lastCounts.stageC)
    }

    /// Whether this pid is a Chromium process (its bundle, or a set of AXManualAccessibility that took); nil before the first read.
    public var chromium: Bool? {
        switch lastProcess {
        case .chromium?: true
        case .native?: false
        case nil: nil
        }
    }

    init(pid: pid_t, allocator: IndexAllocator, manual: ManualAccessibility, lookup: WindowIDLookup = .live) {
        self.pid = pid
        app = AXUIElementCreateApplication(pid)
        book = IndexBook(allocator: allocator)
        handles = HandleTable(capacity: book.capacity)
        self.manual = manual
        resolver = WindowResolver(lookup: lookup)
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), Float(ComputerDefaults.AXWalk.messagingTimeoutMs) / 1_000)
        AXUIElementSetMessagingTimeout(app, Float(ComputerDefaults.AXWalk.messagingTimeoutMs) / 1_000)
        monitor = ChangeMonitor(pid: pid, app: app)
    }

    public var changes: any ChangeSignal { monitor }

    private static func ms() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }

    public func observe(_ request: ObserveRequest) throws -> ObservationText {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { throw ComputerFailure(.unknownSession, "This reader is closed") }
        let start = Self.ms()
        lastProcess = manual.prepare(pid)
        let build = BuildRequest(mode: request.mode, subtreeOf: request.element, budgetBytes: request.budgetBytes, geometry: request.geometry,
                                 space: request.space, loading: request.loading, noteThin: request.noteThin)
        let chromium = lastProcess.map { $0 != .native } ?? false
        // §27.4: the menus the call's steps opened and that are still open, walked once for the block
        let opened = request.openedMenus && request.element == nil ? openedMenus() : []
        /// `last`: no re-read follows, so a selected tab still without a page is `not-drawn`
        func once(last: Bool) throws -> (Built, Base?, WalkNotes, AXUIElement, PageRule.Reading?) {
            let t0 = Self.ms()
            let (snapshot, notes, window) = try read(request)
            let reading = chromium && request.element == nil ? snapshot.roots.first.flatMap(PageRule.read) : nil
            var b = build
            b.page = reading?.state(waitedOut: last)
            b.openedMenus = opened
            let t1 = Self.ms()
            let (built, next) = Builder.build(snapshot, b, book: book, base: base)
            lastWalkMs = t1 - t0
            lastBuildMs = Self.ms() - t1
            return (built, next, notes, window, reading)
        }
        // a selected tab whose page the wait already waited out (`loading`) is not read again
        var (built, next, notes, window, reading) = try once(last: request.loading)
        // a Chromium tree that comes back thin right after the set, or whose selected tab has no page, is read again
        let missing = reading?.missing == true && !request.loading
        let retries = manual.retries(pid, thin: built.stats.thin, pageMissing: missing, readAt: start)
        // a first read slower than the whole schedule: one more read says `not-drawn`
        if missing, retries.isEmpty { (built, next, notes, window, reading) = try once(last: true) }
        for (i, at) in retries.enumerated() {
            let wait = at - Self.ms()
            if wait > 0 { Thread.sleep(forTimeInterval: wait / 1_000) }
            (built, next, notes, window, reading) = try once(last: missing && i == retries.count - 1)
            if !built.stats.thin && reading?.missing != true { break }
        }
        lastPage = reading.flatMap { r in r.selectedTab.flatMap { tab in r.state(waitedOut: r.missing).map { Page(tab: tab.title, state: $0) } } }
        // a selected tab still without its page holds the smart wait (§25.2): the window is the candidate
        if reading?.missing == true { notes.busy.append((window, .pageMissing, [])) }
        if request.element == nil { lastBriefs = built.briefs }
        if request.element == nil, let next { base = next }
        monitor.noteWalk(notes, window: window)
        handles.trim()
        let s = built.stats
        let stats = ObservationStats(elements: s.elements, lines: s.lines, bytes: s.bytes, omitted: s.omitted, thin: s.thin, partial: s.partial,
                                     readMs: Int((Self.ms() - start).rounded()))
        return ObservationText(kind: built.kind, text: built.text, stats: stats, window: built.window, focused: built.focused)
    }

    /// One walk of the request's window (or of one element's subtree) as a snapshot.
    private func read(_ request: ObserveRequest) throws -> (AXSnapshot, WalkNotes, AXUIElement) {
        let target = try resolver.resolve(app: app, pid: pid, ref: request.window)
        let walker = Walker(handles: handles)
        walker.begin()
        let start = Self.ms()
        var roots: [AXNode] = []
        var menuBar: AXNode?
        if let index = request.element {
            walker.cut = false
            walker.valueUnits = max(request.budgetBytes, walker.valueUnits)
            guard let el = try element(index), let node = try walker.walk(root: el, clip: nil, menuBar: false, isWindow: false) else {
                throw ComputerFailure(ComputerError(kind: .staleElement, message: "[\(index)] is gone; read the tree again", element: index, reason: .gone))
            }
            roots = [node]
        } else {
            guard let root = try walker.walk(root: target.element, clip: target.info.frame, menuBar: false, isWindow: true) else {
                throw ComputerFailure(ComputerError(kind: .windowNotFound, message: "The window is gone", candidates: resolver.titles(app)))
            }
            roots = [root]
            for extra in attached(to: target.element, menus: request.menus) {
                let frame = AX.frame(AX.copy(extra, "AXPosition").value, AX.copy(extra, "AXSize").value)
                if let n = try walker.walk(root: extra, clip: frame, menuBar: false, isWindow: false) { roots.append(n) }
            }
            if request.menus, let bar = AX.element(AX.copy(app, "AXMenuBar").value) {
                menuBar = try walker.walk(root: bar, clip: nil, menuBar: true, isWindow: false)
            }
        }
        let focused = AX.element(AX.copy(app, "AXFocusedUIElement").value).map(handles.intern)
        let running = NSRunningApplication(processIdentifier: pid)
        let list = WindowList.entries()
        let others = resolver.windows(of: app).filter { !CFEqual($0, target.element) }.map { w -> OtherWindow in
            let a = AX.batch(w, ["AXTitle", "AXMinimized"])
            let minimized = AX.bool(a["AXMinimized"]?.value) ?? false
            let shown = (try? resolver.describe(w, app: app, pid: pid, list: list))?.onScreen ?? true
            return OtherWindow(title: AX.string(a["AXTitle"]?.value) ?? "", minimized: minimized, otherSpace: !minimized && !shown)
        }
        lastCounts = walker.counts
        let snapshot = AXSnapshot(
            app: AppFacts(pid: pid, bundleId: running?.bundleIdentifier, name: running?.localizedName ?? "pid \(pid)"),
            window: target.info, otherWindows: request.element == nil ? others : [], roots: roots, menuBar: menuBar, focusedID: focused,
            ambientActions: ObservationTables.ambientActions, visited: walker.counts.nodes, partial: walker.partial,
            walkMs: Int((Self.ms() - start).rounded())
        )
        return (snapshot, walker.notes, target.element)
    }

    /// Spec §2.1's focus window beyond the window itself: a context menu, an
    /// open menu-bar menu (when the menu bar is not read whole), the app's
    /// popovers, and its focused dialog when that is not the target.
    private func attached(to window: AXUIElement, menus: Bool) -> [AXUIElement] {
        var out: [AXUIElement] = []
        let children = AX.elements(AX.copy(app, "AXChildren").value)
        for c in children {
            let role = AX.string(AX.copy(c, "AXRole").value)
            if role == "AXMenu" || role == "AXPopover" { out.append(c) }
        }
        if !menus, let bar = AX.element(AX.copy(app, "AXMenuBar").value) {
            for item in AX.elements(AX.copy(bar, "AXChildren").value) where AX.bool(AX.copy(item, "AXSelected").value) == true {
                out += AX.elements(AX.copy(item, "AXChildren").value).filter { AX.string(AX.copy($0, "AXRole").value) == "AXMenu" }
            }
        }
        if let f = AX.element(AX.copy(app, "AXFocusedWindow").value), !CFEqual(f, window),
           let sub = AX.string(AX.copy(f, "AXSubrole").value), ["AXDialog", "AXSystemDialog", "AXFloatingWindow"].contains(sub) {
            out.append(f)
        }
        return out
    }

    private func alive(_ el: AXUIElement) -> Bool {
        if case .gone = AX.copy(el, "AXRole") { return false }
        return true
    }

    /// The live element of a number: `no_such_element` for one never issued; nil for one evicted or gone.
    private func element(_ index: Int) throws -> AXUIElement? {
        guard book.issued(index) else { throw ComputerFailure(ComputerError(kind: .noSuchElement, message: "There is no [\(index)]; read the tree again", element: index)) }
        guard let el = book.id(of: index).flatMap(handles.element), alive(el) else { return nil }
        return el
    }

    /// An index, live (plan §5.4): a rebuilt element is found by one re-read of its window.
    public func resolve(_ index: Int) throws -> ResolvedElement {
        lock.lock()
        defer { lock.unlock() }
        var el = try element(index)
        if el == nil, let base {
            // one re-read of the window the numbers came from, so a rebuilt element is found; that window gone, the number is stale
            do {
                let (snapshot, _, _) = try read(ObserveRequest(window: ComputerProtocol.WindowRef(id: base.windowID), mode: .auto, element: nil,
                                                             budgetBytes: ComputerDefaults.ObservationBudget.defaultBytes, geometry: false, menus: false,
                                                             space: CoordinateSpace(width: 1, height: 1, scale: 1)))
                _ = book.assign(Keep.tree(snapshot), base: base, sameWindow: true)
                el = try element(index)
            } catch let f as ComputerFailure where f.error.kind == .windowNotFound {}
        }
        guard let el else { throw ComputerFailure(ComputerError(kind: .staleElement, message: "[\(index)] is gone; read the tree again", element: index, reason: .gone)) }
        return try describe(index, el)
    }

    /// The element read fresh: its place, its class's batch, its actions, which attributes are settable, its line.
    private func describe(_ index: Int, _ el: AXUIElement) throws -> ResolvedElement {
        let walker = Walker(handles: handles)
        walker.begin()
        walker.descend = false
        guard let node = try walker.walk(root: el, clip: nil, menuBar: false, isWindow: false) else {
            throw ComputerFailure(ComputerError(kind: .staleElement, message: "[\(index)] is gone; read the tree again", element: index, reason: .gone))
        }
        let settable = Set(["AXValue", "AXSelectedText", "AXSelectedTextRange", "AXFocused", "AXSelected"].filter { AX.settable(el, $0) })
        let focused = AX.element(AX.copy(app, "AXFocusedUIElement").value).map { CFEqual($0, el) } ?? false
        var n = node
        n.settable = settable
        n.flags.focused = focused
        let facts = Facts.of(n, FactContext(focusedID: focused ? n.id : nil))
        return ResolvedElement(index: index, element: el, role: n.role, frame: n.frame ?? ComputerProtocol.Rect(x: 0, y: 0, w: 0, h: 0),
                               actions: n.actions, settable: settable, brief: ElementBrief(index: index, line: Facts.body(facts.line)),
                               secure: n.subrole == "AXSecureTextField")
    }

    // MARK: §27, fewer calls

    public func beginCallRecord() { monitor.beginCall() }
    public func recordStep(_ index: Int) { monitor.recordStep(index) }
    public func endCallRecord() { monitor.endCall() }

    public func focusedElement() -> AXUIElement? { AX.element(AX.copy(app, "AXFocusedUIElement").value) }

    public func focusedWindowID() -> Int? {
        AX.element(AX.copy(app, "AXFocusedWindow").value).flatMap { AppWindows.windowID(of: $0, pid: pid) }
    }

    public func index(of element: AXUIElement) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return book.intern(handles.intern(element))
    }

    /// The opened-menu blocks' menus (§27.4): each menu a step of the call opened that still answers, walked whole;
    /// one whose walk fails within the AX timeout (an app in menu tracking) is the silent line. Under the lock.
    private func openedMenus() -> [OpenedMenu] {
        monitor.recorded().filter { $0.kind == .menu }.compactMap { entry -> OpenedMenu? in
            guard alive(entry.element) else { return nil }
            let own = AX.string(AX.copy(entry.element, "AXTitle").value)
            let opener = AX.element(AX.copy(entry.element, "AXParent").value).flatMap { p in
                [AX.string(AX.copy(p, "AXTitle").value), AX.string(AX.copy(p, "AXDescription").value)].compactMap { $0 }.first { !$0.isEmpty }
            }
            let walker = Walker(handles: handles)
            walker.begin()
            walker.cut = false
            let node = try? walker.walk(root: entry.element, clip: nil, menuBar: false, isWindow: false)
            return OpenedMenu(step: entry.step + 1, menu: node, title: (own?.isEmpty == false ? own : nil) ?? opener)
        }
    }

    /// §27.9: the made-appear roots (the record's menus, windows and sheets) first, then the window and what is
    /// attached to it; exact before case-blind, actionable first; several or none is `named_target`.
    public func resolveNamed(_ name: String, window: AXUIElement) throws -> ResolvedElement {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { throw ComputerFailure(.unknownSession, "This reader is closed") }
        let walker = Walker(handles: handles)
        walker.begin()
        var candidates: [NamedTarget.Candidate] = []
        for entry in monitor.recorded() where alive(entry.element) {
            if let n = try walker.walk(root: entry.element, clip: nil, menuBar: false, isWindow: entry.kind == .window) {
                candidates += NamedTarget.candidates(n, madeAppear: true)
            }
        }
        let frame = AX.frame(AX.copy(window, "AXPosition").value, AX.copy(window, "AXSize").value)
        if let n = try walker.walk(root: window, clip: frame, menuBar: false, isWindow: true) { candidates += NamedTarget.candidates(n, madeAppear: false) }
        for extra in attached(to: window, menus: false) {
            if let n = try walker.walk(root: extra, clip: nil, menuBar: false, isWindow: false) { candidates += NamedTarget.candidates(n, madeAppear: false) }
        }
        switch NamedTarget.match(name, among: candidates) {
        case .one(let c):
            guard let el = handles.element(c.id) else { throw noMatch(name) }
            return try describe(book.intern(c.id), el)
        case .several(let all):
            let briefs = all.compactMap { c in handles.element(c.id).flatMap { try? describe(book.intern(c.id), $0).brief } }
            throw ComputerFailure(ComputerError(kind: .namedTarget, message: "Several elements are named \(Quote.json(name)); use element.",
                                                reason: .several, elementCandidates: briefs))
        case .none:
            throw noMatch(name)
        }
    }

    private func noMatch(_ name: String) -> ComputerFailure {
        ComputerFailure(ComputerError(kind: .namedTarget, message: "Nothing named \(Quote.json(name)) in the window or what this call opened.", reason: .noMatch))
    }

    /// §27.10: the menu bar walked as a `menus: true` read walks it, no menu opened, and the path matched in it. A
    /// disabled item answers as §24.2's `menu` route answers one; an item that opens a submenu picks nothing.
    public func resolveMenu(_ path: String) throws -> ResolvedElement {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { throw ComputerFailure(.unknownSession, "This reader is closed") }
        let none = { (what: String, there: [String]) in
            ComputerFailure(ComputerError(kind: .namedTarget, message: "No menu item \(Quote.json(what)) in the menu bar.", reason: .noMatch, available: there))
        }
        guard let bar = AX.element(AX.copy(app, "AXMenuBar").value) else { throw none(path, []) }
        let walker = Walker(handles: handles)
        walker.begin()
        walker.cut = false
        guard let node = try walker.walk(root: bar, clip: nil, menuBar: true, isWindow: false) else { throw none(path, []) }
        switch MenuPath.resolve(path, in: node) {
        case .found(let f):
            let shown = f.titles.joined(separator: " › ")
            if f.submenu {
                throw ComputerFailure(ComputerError(kind: .actionUnsupported, message: "\(shown) opens a submenu; name an item in it.", menu: f.titles))
            }
            if !f.enabled {
                let name = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "the app"
                throw ComputerFailure(ComputerError(kind: .needsTier, message: "\(shown) is disabled while \(name) is in the background.", needed: .session, menu: f.titles))
            }
            guard let el = handles.element(f.id) else { throw none(path, []) }
            return try describe(book.intern(f.id), el)
        case .noMatch(let segment, let titles):
            throw none(MenuPath.parse(path).prefix(segment + 1).joined(separator: " › "), titles)
        case .several(_, let ids):
            let briefs = ids.prefix(NamedTarget.candidatesMax).compactMap { id in handles.element(id).flatMap { try? describe(book.intern(id), $0).brief } }
            throw ComputerFailure(ComputerError(kind: .namedTarget, message: "Several menu items match \(Quote.json(path)); use element.",
                                                reason: .several, elementCandidates: briefs))
        }
    }

    /// §27.7: the focused element and its ancestors, against the call's windows, record and targeted elements.
    public func liveFocus(window: AXUIElement, windows: [AXUIElement], targeted: [Int]) -> LiveFocus? {
        lock.lock()
        defer { lock.unlock() }
        guard !closed, let focused = AX.element(AX.copy(app, "AXFocusedUIElement").value) else { return nil }
        var chain = [focused]
        var up = AX.element(AX.copy(focused, "AXParent").value)
        while let p = up, chain.count < 64 {
            if AX.string(AX.copy(p, "AXRole").value) == "AXApplication" { break }
            chain.append(p)
            up = AX.element(AX.copy(p, "AXParent").value)
        }
        let scope = [window] + windows + monitor.recorded().map(\.element)
        let aimed = targeted.compactMap { book.id(of: $0).flatMap(handles.element) }
        let within = { (set: [AXUIElement]) in chain.contains { c in set.contains { CFEqual($0, c) } } }
        let a = AX.batch(focused, ["AXRole", "AXSubrole"])
        let role = AX.string(a["AXRole"]?.value) ?? ""
        let subrole = AX.string(a["AXSubrole"]?.value)
        let index = book.intern(handles.intern(focused))
        let brief = (try? describe(index, focused).brief) ?? ElementBrief(index: index, line: Facts.roleWord(role, subrole))
        return LiveFocus(element: focused, inScope: within(scope), insideTargeted: within(aimed), secure: subrole == "AXSecureTextField",
                         role: Facts.roleWord(role, subrole), inWebArea: chain.dropFirst().contains { AX.string(AX.copy($0, "AXRole").value) == "AXWebArea" },
                         brief: brief)
    }

    /// The index and line the model's latest window read gave this element; nil for one it did not list.
    public func brief(of element: AXUIElement) -> ElementBrief? {
        lock.lock()
        defer { lock.unlock() }
        guard let id = handles.existing(element), let index = book.index(of: id), let line = lastBriefs[index] else { return nil }
        return ElementBrief(index: index, line: line)
    }

    /// After a tab switch (§25.2): the window's page is a busy candidate until it is there and loaded.
    public func watchPage(window: AXUIElement) {
        monitor.watchPage(window)
    }

    public func resetBase() {
        lock.lock()
        base = nil
        lock.unlock()
    }

    public func close() {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        monitor.close()
        handles.removeAll()
        manual.forget(pid)
    }
}
#endif
