import ApplicationServices
import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import Foundation

/// The menus a call left open, closed after its closing read (docs/computer-protocol.md §26.11,
/// decision 20): AXCancel on the menu, else its opener pressed again, else Escape at `front` when the
/// call allows it; each checked gone. What none of them closed is named on the result.
extension ComputerService {
    func closeMenus(_ target: Resolved, frontAllowed: Bool) async -> [String]? {
        let pid = target.pid
        let windowID = target.windowID
        let frame = target.info.frame
        let space = book.space(target.session, window: windowID)
            ?? capture.space(windowID: windowID, frame: frame, maxEdge: ComputerDefaults.Shot.defaultMaxEdge)
        let box = InputBox(input: input)
        let key = MenuCloser.key(target)
        let done = try? await target.worker.run { state -> (ClosedMenus, [String: OpenMenu])? in
            guard let reader = state.reader else { return nil }
            let menus = reader.openMenus
            // a menu in the app the person is in is theirs to close
            guard !menus.isEmpty, MenuCloser.frontmostPid() != pid else { return nil }
            var book = ClosedMenus()
            var openers: [String: OpenMenu] = [:]
            for (i, m) in menus.enumerated() {
                let id = "\(i)"
                openers[id] = m
                book.saw(OpenedMenu(id: id, title: m.title, opener: MenuCloser.opener(m.kind), items: m.items), itemIndices: m.itemIndices)
                while let way = book.nextClose(id, frontAllowed: frontAllowed) {
                    switch way {
                    case .cancel:
                        AXUIElementPerformAction(m.menu, "AXCancel" as CFString)
                    case .pressOpener:
                        guard let opener = m.opener else { continue }
                        AXUIElementPerformAction(opener, "AXPress" as CFString)
                    case .escapeAtFront:
                        guard let window = state.windows[windowID] else { continue }
                        let escape = InputTarget(pid: pid, windowID: windowID, windowFrame: frame, window: window, space: space, element: nil, startElement: nil, cursor: nil)
                        _ = try? box.input.perform(ComputerAction(action: .key, text: "Escape"), on: escape, tiers: [.front])
                    }
                    usleep(MenuCloser.checkAfterUs)
                    book.checked(id, gone: MenuCloser.gone(m))
                }
            }
            return (book, openers)
        }
        guard let (book, openers) = done ?? nil else { return nil }
        lock.withLock { closedMenus[key] = (book, openers) }
        return book.leftOpen
    }

    /// §26.11: a step naming an item of a menu this session's last call closed reaches it again: a
    /// pop-up's, menu button's or context menu's by pressing its opener and the item by title (nil when
    /// the index is no such item, or when the item still answers, so the ordinary route runs). Answers
    /// the `on` words, `Action › New Folder`.
    func reachClosedItem(_ target: Resolved, index: Int) async throws -> String? {
        let key = MenuCloser.key(target)
        guard let (book, openers) = lock.withLock({ closedMenus[key] }), let way = book.reach(index: index) else { return nil }
        guard case .reopen(let openerId, let item, let on) = way, let menu = openers[openerId], menu.opener != nil else { return nil }
        return try await target.worker.run { state -> String? in
            guard let opener = menu.opener else { return nil }
            // an item that still answers (a menu-bar item takes AXPress closed) runs the ordinary way
            if let reader = state.reader, (try? reader.resolve(index)) != nil { return nil }
            AXUIElementPerformAction(opener, "AXPress" as CFString)
            let deadline = Date().addingTimeInterval(Double(MenuCloser.reopenWaitMs) / 1000)
            var pressed = false
            while Date() < deadline {
                if let found = MenuCloser.item(titled: item, under: opener) {
                    let err = AXUIElementPerformAction(found, "AXPress" as CFString)
                    guard err == .success else { throw ComputerError(kind: .actionUnsupported, message: "\(on) did not take the press.") }
                    pressed = true
                    break
                }
                usleep(20_000)
            }
            guard pressed else {
                AXUIElementPerformAction(opener, "AXCancel" as CFString)
                throw ComputerError(kind: .staleElement, message: "[\(index)] \(on) is gone; read the window again.", element: index, reason: .gone)
            }
            return on
        }
    }

    /// An app that answered no read: a menu-level window of its pid is a menu it is stuck in. Escape at
    /// `front` closes it when the call allows that; true when the menu is gone and the read may run again.
    func closeStuckMenu(_ target: Resolved, frontAllowed: Bool) async -> Bool {
        let pid = target.pid
        guard frontAllowed, MenuCloser.menuWindowShowing(pid: pid) else { return false }
        let windowID = target.windowID
        let frame = target.info.frame
        let space = book.space(target.session, window: windowID)
            ?? capture.space(windowID: windowID, frame: frame, maxEdge: ComputerDefaults.Shot.defaultMaxEdge)
        let box = InputBox(input: input)
        _ = try? await target.worker.run { state -> Bool in
            guard let window = state.windows[windowID] else { return false }
            let escape = InputTarget(pid: pid, windowID: windowID, windowFrame: frame, window: window, space: space, element: nil, startElement: nil, cursor: nil)
            _ = try? box.input.perform(ComputerAction(action: .key, text: "Escape"), on: escape, tiers: [.front])
            return true
        }
        try? await Task.sleep(for: .milliseconds(100))
        return !MenuCloser.menuWindowShowing(pid: pid)
    }
}

enum MenuCloser {
    /// a close settles this long before the check
    static let checkAfterUs: UInt32 = 50_000
    /// a reopened menu shows its items within this (E2' measured 320 ms for a pop-up)
    static let reopenWaitMs = 600

    /// The book of a session's app.
    static func key(_ target: Resolved) -> String { "\(target.session):\(target.pid)" }

    /// The item titled `title` in the AXMenu the opener holds now.
    static func item(titled title: String, under opener: AXUIElement) -> AXUIElement? {
        var kids: CFTypeRef?
        guard AXUIElementCopyAttributeValue(opener, "AXChildren" as CFString, &kids) == .success, let list = kids as? [AXUIElement],
              let menu = list.first(where: { role($0) == "AXMenu" }) else { return nil }
        var items: CFTypeRef?
        guard AXUIElementCopyAttributeValue(menu, "AXChildren" as CFString, &items) == .success, let all = items as? [AXUIElement] else { return nil }
        return all.first { e in
            var t: CFTypeRef?
            return AXUIElementCopyAttributeValue(e, "AXTitle" as CFString, &t) == .success && (t as? String) == title
        }
    }

    /// The verbs that press a menu item: `perform pick`, `perform press`, a plain click.
    static func pressesItem(_ action: ComputerAction) -> Bool {
        switch action.action {
        case .perform: action.name == "pick" || action.name == "press"
        case .leftClick: (action.text ?? "").isEmpty && action.duration == nil
        default: false
        }
    }

    static func opener(_ kind: OpenMenu.Opener) -> MenuOpener {
        switch kind {
        case .menuBar: .menuBar
        case .popUp: .popUp
        case .context: .context
        }
    }

    /// Gone: the opener holds no AXMenu any more, or a menu read as a root no longer answers.
    static func gone(_ m: OpenMenu) -> Bool {
        if let opener = m.opener {
            var kids: CFTypeRef?
            guard AXUIElementCopyAttributeValue(opener, "AXChildren" as CFString, &kids) == .success, let list = kids as? [AXUIElement] else { return true }
            return !list.contains { role($0) == "AXMenu" }
        }
        return role(m.menu) == nil
    }

    static func role(_ e: AXUIElement) -> String? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, "AXRole" as CFString, &v) == .success else { return nil }
        return v as? String
    }

    /// The app in front, by AX.
    static func frontmostPid() -> pid_t? {
        var app: CFTypeRef?
        guard AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), "AXFocusedApplication" as CFString, &app) == .success, let app,
              CFGetTypeID(app) == AXUIElementGetTypeID() else { return nil }
        var pid: pid_t = 0
        return AXUIElementGetPid(app as! AXUIElement, &pid) == .success ? pid : nil
    }

    /// A window of the pid at a menu's level (the menu bar's 24 and up) is on screen.
    static func menuWindowShowing(pid: pid_t) -> Bool {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return false }
        return list.contains { w in
            (w[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ((w[kCGWindowLayer as String] as? Int) ?? 0) >= Int(CGWindowLevelForKey(.mainMenuWindow))
        }
    }
}
