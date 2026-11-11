import AppKit
import ApplicationServices
import ComputerCore
import ComputerProtocol
import Foundation

// `save_as`, live (docs/computer-protocol.md §26.7): SavePanelFlow (PanelPlan.swift) decides each
// move from what this reads of the window's sheets and the app's dialogs; this does the move over AX,
// inside a `front` hold for the parts only an active app runs, and proves the file on disk.

/// The window's sheets and the app's dialogs as one tree for the panel search, with each node's element.
struct PanelRead {
    var root: PanelNode
    var elements: [[Int]: AXUIElement]

    static let maxNodes = 1_500
    static let maxDepth = 14

    static func read(window: AXUIElement, pid: pid_t) -> PanelRead {
        var elements: [[Int]: AXUIElement] = [:]
        var count = 0
        var roots: [AXUIElement] = AX.elements(window, "AXChildren").filter { AX.string($0, "AXRole") == "AXSheet" }
        // an app-modal save panel is a dialog of the app's own
        roots += AX.elements(AX.app(pid), "AXWindows").filter { !AX.same($0, window) && AX.string($0, "AXIdentifier") == PanelIDs.panel }
        func node(_ e: AXUIElement, _ at: [Int], depth: Int, defaultButton: AXUIElement?) -> PanelNode {
            count += 1
            elements[at] = e
            AX.setTimeout(e, seconds: InputTiming.axTimeoutS)
            let v = AX.many(e, ["AXRole", "AXSubrole", "AXIdentifier", "AXTitle", "AXDescription", "AXValue", "AXChildren", "AXDefaultButton"])
            let role = v[0] as? String ?? ""
            let own = (v[7]).flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
            var n = PanelNode(role: role, subrole: v[1] as? String, identifier: v[2] as? String, title: v[3] as? String, description: v[4] as? String,
                              value: v[5] as? String, isDefault: defaultButton.map { AX.same($0, e) } ?? false)
            if depth < maxDepth, let kids = v[6] as? [AXUIElement] {
                for (i, k) in kids.enumerated() where count < maxNodes {
                    n.children.append(node(k, at + [i], depth: depth + 1, defaultButton: own ?? defaultButton))
                }
            }
            return n
        }
        var root = PanelNode(role: "AXWindow")
        for (i, r) in roots.enumerated() where count < maxNodes {
            root.children.append(node(r, [i], depth: 1, defaultButton: nil))
        }
        return PanelRead(root: root, elements: elements)
    }

    func element(_ path: [Int]?) -> AXUIElement? { path.flatMap { elements[$0] } }
}

extension InputEngine {
    /// One `save_as` step at `tier` (`ax`, or `front` once a part needed it): the panel opened, the folder
    /// and the name set, Save pressed, a Replace alert answered only with `replace`, the file proved.
    func saveAs(_ action: ComputerAction, target: InputTarget, tiers: [Tier], at tier: Tier) throws -> InputOutcome {
        let home = NSHomeDirectory()
        guard let path = action.path, let goal = SaveTarget.parse(path, home: home) else {
            throw ComputerFailure(.actionUnsupported, "save_as needs an absolute path or ~/…, with the file name.")
        }
        let pid = target.pid
        let app = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "The app"
        let frontAllowed = tiers.contains(.front)
        var flow = SavePanelFlow(target: goal, replace: action.replace ?? false, app: app, frontAllowed: frontAllowed,
                                 appActive: NSRunningApplication(processIdentifier: pid)?.isActive ?? false)
        let startedAt = Date().timeIntervalSince1970 - 1
        var hold: FrontHold?
        var read = PanelRead.read(window: target.window, pid: pid)
        for _ in 0 ..< 400 {
            if target.cancelled() { throw cancelledFailure() }
            let parts = SavePanelParts.find(in: read.root)
            let value = { (p: [Int]?) in p.flatMap { read.root.at($0)?.value } }
            let observed = PanelObservation(
                now: Int((clock.seconds() * 1000).rounded()), parts: parts, nameValue: value(parts?.nameField), pathValue: value(parts?.pathField),
                whereValue: value(parts?.wherePopup), fileMenu: parts == nil ? fileMenu(pid) : [],
                windowHasFile: AX.string(target.window, "AXDocument").map { $0.hasPrefix("file:") } ?? false
            )
            switch flow.next(observed) {
            case .read(let ms):
                clock.sleep(ms: ms)
            case .pressMenu(let menuPath, let atFront):
                guard let item = menuElement(pid, menuPath) else { throw ComputerFailure(.actionUnsupported, "\(menuPath.joined(separator: " › ")) is not in \(app)'s menu bar.") }
                if atFront {
                    hold = try inHold(target, app: app) { ctx in
                        try enabledInHold(item, path: menuPath, ctx: ctx)
                        try AX.press(item, what: menuPath.joined(separator: " › "))
                    }
                } else {
                    try AX.press(item, what: menuPath.joined(separator: " › "))
                }
            case .insert(let part, let text, let selectAll):
                guard let e = read.element(partPath(part, parts)) else { throw lostPanel(app, goal) }
                if selectAll, let length = (AX.string(e, "AXValue") ?? "").utf16.count as Int? {
                    var range = CFRange(location: 0, length: length)
                    if let v = AXValueCreate(.cfRange, &range) { AX.set(e, "AXSelectedTextRange", v) }
                }
                let err = AX.set(e, "AXSelectedText", text as CFString)
                if err != .success { throw AX.failure(err, element: nil, what: "take \(text)") }
            case .setValue(let part, let text):
                guard let e = read.element(partPath(part, parts)) else { throw lostPanel(app, goal) }
                let err = AX.set(e, "AXValue", text as CFString)
                if err != .success { throw AX.failure(err, element: nil, what: "take \(text)") }
            case .press(let part):
                guard let e = read.element(partPath(part, parts)) else { throw lostPanel(app, goal) }
                try AX.press(e, what: "be pressed")
            case .confirmGoTo:
                // E4': Go to Folder confirms only in the active app: AXConfirm first, else Return to the panel's own pid
                guard let field = read.element(parts?.pathField) else { throw lostPanel(app, goal) }
                hold = try inHold(target, app: app) { ctx in
                    try ctx.check()
                    AX.perform(field, "AXConfirm")
                    let until = clock.seconds() + Double(InputTiming.frontSettleMs) / 1000
                    while clock.seconds() < until, AX.string(field, "AXRole") != nil {
                        clock.sleep(ms: InputTiming.frontPollMs)
                    }
                    guard AX.string(field, "AXRole") != nil else { return }
                    try ctx.check()
                    var panelPid: pid_t = 0
                    if AXUIElementGetPid(field, &panelPid) != .success { panelPid = pid }
                    sink.post(.key(36, down: true, flags: []), route: .pid(panelPid, windowID: target.windowID))
                    sink.post(.key(36, down: false, flags: []), route: .pid(panelPid, windowID: target.windowID))
                }
            case .needsFront(let menu):
                if tier == .ax { throw RouteFellThrough() }
                throw needsTierForSave(menu: menu, app: app)
            case .checkDisk:
                let names = (try? FileManager.default.contentsOfDirectory(atPath: goal.folder)) ?? []
                var after: [String: Double] = [:]
                for name in names {
                    let attrs = try? FileManager.default.attributesOfItem(atPath: (goal.folder as NSString).appendingPathComponent(name))
                    if let d = attrs?[.modificationDate] as? Date { after[name] = d.timeIntervalSince1970 }
                }
                let document = AX.string(target.window, "AXDocument").flatMap { URL(string: $0) }.flatMap { $0.isFileURL ? $0.path : nil }
                switch SaveProof.judge(goal, after: after, startedAt: startedAt, documentAfter: document, app: app) {
                case .success(let saved):
                    var out = InputOutcome(tier: flow.tier, via: .panel, clipboard: nil, cursor: target.cursor, lastInputAt: clock.ticks(), on: goal.on)
                    out.front = hold
                    out.disk = DiskChange(saved: middleCut(tildePath(saved, home: home), max: ComputerDefaults.Front.pathMaxUnits))
                    return out
                case .failure(let error):
                    throw withHold(ComputerFailure(error), hold)
                }
            case .fail(let error):
                throw withHold(ComputerFailure(error), hold)
            }
            read = PanelRead.read(window: target.window, pid: pid)
        }
        throw withHold(ComputerFailure(ComputerError(kind: .timeout, message: "\(app)'s save panel did not finish.")), hold)
    }

    /// A part of the flow inside a hold of its own; answers the hold's report.
    private func inHold(_ target: InputTarget, app: String, _ body: (FrontHoldContext) throws -> Void) throws -> FrontHold {
        try frontTier.hold(pid: target.pid, window: target.window, app: app, cancelled: target.cancelled, changedSince: target.changedSince, body: body).1
    }

    private func partPath(_ part: PanelPart, _ parts: SavePanelParts?) -> [Int]? {
        guard let parts else { return nil }
        switch part {
        case .nameField: return parts.nameField
        case .pathField: return parts.pathField
        case .ok: return parts.ok
        case .cancel: return parts.cancel
        case .replace: return parts.replace
        case .replaceCancel: return parts.replaceCancel
        }
    }

    /// The File menu's items, for the flow's choice of Save As… or Save….
    private func fileMenu(_ pid: pid_t) -> [MenuItemFacts] {
        let source = LiveMenuSource(app: AX.app(pid))
        guard let file = source.barItems().first(where: { AX.string($0, "AXTitle") == "File" }) else { return [] }
        return source.items(file).map(source.facts)
    }

    /// The bar item and item a path names, `["File", "Save As…"]`.
    private func menuElement(_ pid: pid_t, _ path: [String]) -> AXUIElement? {
        let source = LiveMenuSource(app: AX.app(pid))
        guard let first = path.first, var node = source.barItems().first(where: { AX.string($0, "AXTitle") == first }) else { return nil }
        for title in path.dropFirst() {
            guard let next = source.items(node).first(where: { AX.string($0, "AXTitle") == title }) else { return nil }
            node = next
        }
        return node
    }

    private func lostPanel(_ app: String, _ goal: SaveTarget) -> ComputerFailure {
        ComputerFailure(ComputerError(kind: .notCommitted, message: "\(app) closed the save panel and no file appeared in \(goal.displayFolder)."))
    }

    private func needsTierForSave(menu: [String]?, app: String) -> ComputerFailure {
        let what = menu.map { "\($0.joined(separator: " › ")) is disabled while \(app) is in the background" } ?? "\(app)'s save panel goes to a folder only with the app in front"
        return ComputerFailure(ComputerError(kind: .needsTier, message: "\(what).", needed: .front, menu: menu))
    }

    private func withHold(_ error: ComputerFailure, _ hold: FrontHold?) -> Error {
        hold.map { withFront(error, $0) } ?? error
    }
}

extension AX {
    /// AXPress, failing with the element's own words.
    static func press(_ e: AXUIElement, what: String) throws {
        let err = perform(e, "AXPress")
        if err != .success { throw failure(err, element: nil, what: what) }
    }
}
