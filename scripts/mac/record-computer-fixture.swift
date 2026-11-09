// record-computer-fixture: one scratch window's AX tree and screenshot for
// src/main/server/computer/fixtures/apps/<app>/<state>/ (docs/computer-protocol.md "Fixtures").
// Kept in the repo, run on the Mac by scripts/mac/record-computer-fixtures.sh, never shipped.
//
//   record       --pid P --title T --out DIR --app NAME --state STATE
//                [--after-state S --after-action WORDS] [--setup WORDS]... [--appshot AXDUMP.json] [--max-edge 1280]
//   wait-window  --pid P --title T [--timeout 15]
//   (every command: --title "" needs --contains AXRole=Name, an element inside that window)
//   set-value    --pid P --title T --role AXRole [--name N] --value V
//   select-range --pid P --title T --role AXRole [--name N] --range LOC,LEN
//   insert-text  --pid P --title T --role AXRole [--name N] --text V
//   press        --pid P --title T --role AXRole [--subrole AXSubrole] [--name N] [--action AXPress]
//   wait-element --pid P --title T --role AXRole [--subrole S] [--name N] [--timeout 10]
//   pick         --pid P --title T --popup NAME --item ITEM   (prints the popup's first item before the pick)
//   key          --pid P --key 1|s|w|n|escape|return|tab|space [--mods cmd,shift,alt,ctrl]
//
// Only the window titled exactly --title is ever read or acted on; any other
// title is refused. Every string written is rewritten: the home directory to
// /Users/me, the host name to mac, the account's full name to Me.
import AppKit
import ApplicationServices
import ScreenCaptureKit
import UniformTypeIdentifiers

let recorderVersion = "record-computer-fixture 1"
let rawValueMax = 2_000
let nodeCap = 20_000
let walkDeadlineMs = 60_000.0

setvbuf(stdout, nil, _IONBF, 0)
_ = NSApplication.shared
_ = CGMainDisplayID()

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(code)
}

/// `v`, or exit with the message (`?? fail(...)` does not type-check: an autoclosure returning Never is not a T).
func orFail<T>(_ v: T?, _ message: @autoclosure () -> String, code: Int32 = 1) -> T {
    if let v { return v }
    fail(message(), code: code)
}

func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }

// MARK: - arguments

var argv = Array(CommandLine.arguments.dropFirst())
guard let command = argv.first else { fail("usage: record | wait-window | set-value | select-range | insert-text | press | key", code: 2) }
argv.removeFirst()
var options: [String: [String]] = [:]
do {
    var i = 0
    while i < argv.count {
        let a = argv[i]
        guard a.hasPrefix("--"), i + 1 < argv.count else { fail("bad argument \(a)", code: 2) }
        options[String(a.dropFirst(2)), default: []].append(argv[i + 1])
        i += 2
    }
}
func one(_ k: String) -> String? { options[k]?.last }
func need(_ k: String) -> String { orFail(one(k), "--\(k) is required", code: 2) }

// MARK: - privacy

let rewrites: [(String, String)] = {
    var pairs: [(String, String)] = [(NSHomeDirectory(), "/Users/me"), ("/Users/\(NSUserName())", "/Users/me")]
    let host = ProcessInfo.processInfo.hostName
    var hosts = [host, String(host.split(separator: ".").first ?? ""), Host.current().localizedName ?? ""]
    hosts.append(contentsOf: hosts.map { $0.replacingOccurrences(of: "-", with: " ") })
    for h in hosts where h.count >= 3 { pairs.append((h, "mac")) }
    let full = NSFullUserName()
    if full.count >= 3 { pairs.append((full, "Me")) }
    if NSUserName().count >= 3 { pairs.append((NSUserName(), "me")) }
    return pairs.sorted { $0.0.count > $1.0.count }
}()

func scrub(_ s: String) -> String { rewrites.reduce(s) { $0.replacingOccurrences(of: $1.0, with: $1.1) } }

/// At most `max` Unicode scalars, then the marker the observation grammar uses.
func cut(_ s: String, _ max: Int) -> String {
    let scalars = Array(s.unicodeScalars)
    guard scalars.count > max else { return s }
    var view = String.UnicodeScalarView()
    view.append(contentsOf: scalars.prefix(max))
    return String(view) + "…(+\(scalars.count - max) chars)"
}

// MARK: - AX reads

func copyAttr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func asString(_ v: CFTypeRef?) -> String? {
    guard let v else { return nil }
    let t = CFGetTypeID(v)
    if t == CFStringGetTypeID() { return v as? String }
    if t == CFAttributedStringGetTypeID() { return (v as! NSAttributedString).string }
    if t == CFURLGetTypeID() { return (v as! URL).absoluteString }
    return nil
}

func asBool(_ v: CFTypeRef?) -> Bool? {
    guard let v else { return nil }
    let t = CFGetTypeID(v)
    if t == CFBooleanGetTypeID() { return CFBooleanGetValue((v as! CFBoolean)) }
    if t == CFNumberGetTypeID() { return (v as! NSNumber).boolValue }
    if t == CFStringGetTypeID() { return (v as! String) == "true" }
    return nil
}

func asElement(_ v: CFTypeRef?) -> AXUIElement? {
    guard let v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

func asElements(_ v: CFTypeRef?) -> [AXUIElement] {
    guard let v, CFGetTypeID(v) == CFArrayGetTypeID() else { return [] }
    return (v as! [AnyObject]).compactMap { asElement($0 as CFTypeRef) }
}

func axValue<T>(_ v: CFTypeRef?, _ type: AXValueType, _ empty: T) -> T? {
    guard let v, CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == type else { return nil }
    var out = empty
    return AXValueGetValue(v as! AXValue, type, &out) ? out : nil
}

struct RawValue: Codable { var type: String; var text: String }

func rawValue(_ v: CFTypeRef?) -> RawValue? {
    guard let v else { return nil }
    let t = CFGetTypeID(v)
    if let s = asString(v) { return RawValue(type: "string", text: cut(scrub(s), rawValueMax)) }
    if t == CFBooleanGetTypeID() { return RawValue(type: "bool", text: asBool(v)! ? "true" : "false") }
    if t == CFNumberGetTypeID() { return RawValue(type: "number", text: (v as! NSNumber).stringValue) }
    if t == AXValueGetTypeID() {
        if let r = axValue(v, .cfRange, CFRange()) { return RawValue(type: "other", text: "range \(r.location),\(r.length)") }
        if let p = axValue(v, .cgPoint, CGPoint.zero) { return RawValue(type: "other", text: "point \(p.x),\(p.y)") }
        if let s = axValue(v, .cgSize, CGSize.zero) { return RawValue(type: "other", text: "size \(s.width),\(s.height)") }
        return RawValue(type: "other", text: "<axvalue>")
    }
    if t == AXUIElementGetTypeID() { return RawValue(type: "other", text: "<element>") }
    if t == CFArrayGetTypeID() { return RawValue(type: "other", text: "<array \((v as! [AnyObject]).count)>") }
    return RawValue(type: "other", text: "<\(CFCopyTypeIDDescription(t) as String)>")
}

struct Rect: Codable { var x: Double; var y: Double; var w: Double; var h: Double }

final class RawNode: Codable {
    var role = "AXUnknown"
    var subrole: String?
    var roleDescription: String?
    var title: String?
    var value: RawValue?
    var description: String?
    var help: String?
    var placeholder: String?
    var identifier: String?
    var domIdentifier: String?
    var titleElementValue: String?
    var enabled: Bool?
    var focused: Bool?
    var selected: Bool?
    var expanded: Bool?
    var required: Bool?
    var invalid: Bool?
    var modal: Bool?
    var minimized: Bool?
    var busy: Bool?
    var loaded: Bool?
    var visible: Bool?
    var frame: Rect?
    var actions: [String]?
    var settable: [String]?
    var selectedTextRange: [Int]?
    var children: [RawNode] = []
}

let readKeys = [
    "AXRole", "AXSubrole", "AXRoleDescription", "AXTitle", "AXValue", "AXDescription", "AXHelp",
    "AXPlaceholderValue", "AXIdentifier", "AXDOMIdentifier", "AXTitleUIElement", "AXEnabled", "AXFocused",
    "AXSelected", "AXExpanded", "AXRequired", "AXInvalid", "AXModal", "AXMinimized", "AXElementBusy", "AXLoaded",
    "AXPosition", "AXSize", "AXSelectedTextRange", "AXChildren", "AXVisibleRows", "AXVisibleChildren"
]
let settableKeys = ["AXValue", "AXSelectedText", "AXSelectedTextRange", "AXFocused", "AXSelected"]

/// Every attribute of `readKeys` in one call; a missing one is absent.
func readAll(_ el: AXUIElement) -> [String: CFTypeRef] {
    var out: [String: CFTypeRef] = [:]
    var vals: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(el, readKeys as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &vals) == .success,
          let arr = vals as [AnyObject]? else { return out }
    for (i, k) in readKeys.enumerated() where i < arr.count {
        let v = arr[i] as CFTypeRef
        if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { continue }
        out[k] = v
    }
    return out
}

final class Walker {
    var nodes = 0
    var depth = 0
    var capped = false
    let deadline = now() + walkDeadlineMs

    func walk(_ el: AXUIElement, at level: Int) -> RawNode {
        nodes += 1
        depth = max(depth, level)
        let a = readAll(el)
        let n = RawNode()
        n.role = asString(a["AXRole"]) ?? "AXUnknown"
        n.subrole = asString(a["AXSubrole"])
        n.roleDescription = asString(a["AXRoleDescription"]).map(scrub)
        n.title = asString(a["AXTitle"]).map { cut(scrub($0), rawValueMax) }
        n.value = rawValue(a["AXValue"])
        n.description = asString(a["AXDescription"]).map { cut(scrub($0), rawValueMax) }
        n.help = asString(a["AXHelp"]).map { cut(scrub($0), rawValueMax) }
        n.placeholder = asString(a["AXPlaceholderValue"]).map(scrub)
        n.identifier = asString(a["AXIdentifier"]).map(scrub)
        n.domIdentifier = asString(a["AXDOMIdentifier"]).map(scrub)
        if let title = asElement(a["AXTitleUIElement"]) {
            n.titleElementValue = (asString(copyAttr(title, "AXValue")) ?? asString(copyAttr(title, "AXTitle"))).map { cut(scrub($0), rawValueMax) }
        }
        n.enabled = asBool(a["AXEnabled"])
        n.focused = asBool(a["AXFocused"])
        n.selected = asBool(a["AXSelected"])
        n.expanded = asBool(a["AXExpanded"])
        n.required = asBool(a["AXRequired"])
        n.invalid = asBool(a["AXInvalid"])
        n.modal = asBool(a["AXModal"])
        n.minimized = asBool(a["AXMinimized"])
        n.busy = asBool(a["AXElementBusy"])
        n.loaded = asBool(a["AXLoaded"])
        if let p = axValue(a["AXPosition"], .cgPoint, CGPoint.zero), let s = axValue(a["AXSize"], .cgSize, CGSize.zero) {
            n.frame = Rect(x: p.x, y: p.y, w: s.width, h: s.height)
        }
        if let r = axValue(a["AXSelectedTextRange"], .cfRange, CFRange()) { n.selectedTextRange = [r.location, r.length] }
        var acts: CFArray?
        if AXUIElementCopyActionNames(el, &acts) == .success, let list = acts as? [String], !list.isEmpty {
            n.actions = list.map(scrub)
        }
        var names: CFArray?
        if AXUIElementCopyAttributeNames(el, &names) == .success, let present = names as? [String] {
            let settable = settableKeys.filter { key in
                guard present.contains(key) else { return false }
                var ok: DarwinBoolean = false
                return AXUIElementIsAttributeSettable(el, key as CFString, &ok) == .success && ok.boolValue
            }
            if !settable.isEmpty { n.settable = settable }
        }
        let children = asElements(a["AXChildren"])
        let visibleList = asElements(a["AXVisibleRows"]) + asElements(a["AXVisibleChildren"])
        let listsVisible = a["AXVisibleRows"] != nil || a["AXVisibleChildren"] != nil
        for child in children {
            if nodes >= nodeCap || now() > deadline { capped = true; break }
            let c = walk(child, at: level + 1)
            if listsVisible { c.visible = visibleList.contains { CFEqual($0, child) } }
            n.children.append(c)
        }
        return n
    }
}

// MARK: - the window

let pid: pid_t = orFail(pid_t(need("pid")), "--pid is not a number", code: 2)
let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 2.0)

/// The one window titled exactly `title`; any other is never read. An empty title (an
/// IntelliJ project frame names itself nowhere) also needs `--contains AXRole=Name`, an
/// element that must be inside that window, and more than one such window is refused.
func window(titled title: String) -> AXUIElement? {
    let titled = asElements(copyAttr(app, "AXWindows")).filter { (asString(copyAttr($0, "AXTitle")) ?? "") == title }
    guard title.isEmpty else { return titled.first }
    guard let mark = one("contains"), let eq = mark.firstIndex(of: "=") else { fail("an empty --title needs --contains AXRole=Name", code: 2) }
    let role = String(mark[..<eq]), name = String(mark[mark.index(after: eq)...])
    let matching = titled.filter { find(in: $0, role: role, subrole: nil, name: name) != nil }
    if matching.count > 1 { fail("\(matching.count) untitled windows hold \(mark)", code: 3) }
    return matching.first
}

func requireWindow() -> AXUIElement {
    let title = need("title")
    return orFail(window(titled: title), "no window titled \(title) in pid \(pid)", code: 3)
}

/// The first element under `root` (sheets and dialogs included) with the role and, when given, the subrole and name.
func find(in root: AXUIElement, role: String, subrole: String?, name: String?) -> AXUIElement? {
    var stack = [root]
    var seen = 0
    while let el = stack.popLast(), seen < nodeCap {
        seen += 1
        if asString(copyAttr(el, "AXRole")) == role, subrole == nil || asString(copyAttr(el, "AXSubrole")) == subrole {
            if name == nil { return el }
            let labels = [
                asString(copyAttr(el, "AXTitle")), asString(copyAttr(el, "AXDescription")),
                asString(copyAttr(el, "AXValue")),
                asElement(copyAttr(el, "AXTitleUIElement")).flatMap { asString(copyAttr($0, "AXValue")) }
            ]
            if labels.contains(where: { $0 == name }) { return el }
        }
        stack.append(contentsOf: asElements(copyAttr(el, "AXChildren")).reversed())
    }
    return nil
}

func requireElement() -> AXUIElement {
    let role = need("role")
    let name = one("name")
    return orFail(find(in: requireWindow(), role: role, subrole: one("subrole"), name: name),
                  "no \(role)\(name.map { " named \($0)" } ?? "") in the window", code: 4)
}

func check(_ rc: AXError, _ what: String) {
    if rc != .success { fail("\(what) failed: AXError \(rc.rawValue)", code: 5) }
}

// MARK: - the screenshot

func jpeg(_ img: CGImage, quality: Double) -> Data {
    let data = NSMutableData()
    let dst = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dst, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    CGImageDestinationFinalize(dst)
    return data as Data
}

func area(_ r: CGRect) -> Double { r.isNull ? 0 : Double(r.width * r.height) }

/// The SCWindow of this pid with this title whose frame is nearest the AX frame.
func shoot(title: String, axFrame: Rect, maxEdge: Int, to path: String) async throws -> (width: Int, height: Int, bytes: Int, scale: Double, overlays: Int) {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    // Chrome's AX title ends " - Google Chrome", its window server title does not: accept
    // that one form, nothing looser, and only a window on the AX window's frame.
    let appName = NSRunningApplication(processIdentifier: pid)?.localizedName ?? ""
    func sameTitle(_ t: String?) -> Bool {
        if title.isEmpty { return t?.isEmpty ?? true }
        guard let t, !t.isEmpty else { return false }
        return t == title || (!appName.isEmpty && "\(t) - \(appName)" == title)
    }
    let candidates = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 && sameTitle($0.title) }
    func distance(_ w: SCWindow) -> Double {
        abs(w.frame.minX - axFrame.x) + abs(w.frame.minY - axFrame.y) + abs(w.frame.width - axFrame.w) + abs(w.frame.height - axFrame.h)
    }
    guard let win = candidates.min(by: { distance($0) < distance($1) }), distance(win) <= 8 else {
        fail("no shareable window titled \(title) on its frame", code: 6)
    }
    // An open popup menu is a window of its own above the window (a select's menu in
    // Chrome): when this pid has one over the window, shoot the display with only the
    // window and those popups in it, cropped to the window, so no other app shows.
    let overlays = content.windows.filter {
        $0.owningApplication?.processID == pid && $0.windowLayer > 0 && $0.isOnScreen && $0.frame.intersects(win.frame)
    }
    let display = content.displays.max { a, b in
        area(a.frame.intersection(win.frame)) < area(b.frame.intersection(win.frame))
    }
    let filter: SCContentFilter
    var source: CGRect?
    if !overlays.isEmpty, let display, area(display.frame.intersection(win.frame)) > 0 {
        filter = SCContentFilter(display: display, including: [win] + overlays)
        let visible = display.frame.intersection(win.frame)
        source = visible.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
    } else {
        filter = SCContentFilter(desktopIndependentWindow: win)
    }
    let pointScale = Double(filter.pointPixelScale)
    let pw = (source?.width ?? filter.contentRect.width) * pointScale
    let ph = (source?.height ?? filter.contentRect.height) * pointScale
    let k = min(1, Double(maxEdge) / max(pw, ph, 1), (3_750_000 / max(pw * ph, 1)).squareRoot())
    let cfg = SCStreamConfiguration()
    if let source { cfg.sourceRect = source }
    cfg.width = Int((pw * k).rounded())
    cfg.height = Int((ph * k).rounded())
    cfg.showsCursor = false
    cfg.captureResolution = .best
    let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    let data = jpeg(img, quality: 0.85)
    try data.write(to: URL(fileURLWithPath: path))
    return (img.width, img.height, data.count, pointScale, overlays.count)
}

// MARK: - record

struct WindowMeta: Codable { var title: String; var frame: Rect }
struct WalkStats: Codable { var nodes: Int; var depth: Int; var ms: Int; var capped: Bool }
struct AppMeta: Codable { var name: String; var bundleId: String?; var version: String }
struct Tree: Codable {
    var recordedAt: String
    var recorder: String
    var app: AppMeta
    var os: String
    var window: WindowMeta
    var scale: Double
    var manualAccessibility: String
    var walk: WalkStats
    var root: RawNode
    var attached: [RawNode]?
}
struct ShotMeta: Codable { var file: String; var width: Int; var height: Int; var bytes: Int; var maxEdge: Int; var scale: Double; var popups: Int? }
struct After: Codable { var state: String; var action: String }
struct Meta: Codable {
    var app: String
    var state: String
    var recordedAt: String
    var recorder: String
    var macos: String
    var backingScale: Double
    var window: WindowMeta
    var shot: ShotMeta
    var walk: WalkStats
    var setup: [String]
    var after: After?
    var appshot: Bool
}

func write<T: Encodable>(_ value: T, to path: String) throws {
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    var data = try enc.encode(value)
    data.append(0x0A)
    try data.write(to: URL(fileURLWithPath: path))
}

@MainActor func record() async throws {
    let title = need("title")
    let out = need("out")
    let maxEdge = Int(one("max-edge") ?? "1280") ?? 1280
    try FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
    let manual = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success ? "set" : "refused"
    let win = requireWindow()
    // Chromium builds its tree after the set: walk until it stops growing.
    var best: (node: RawNode, walker: Walker, ms: Int)?
    for pause in manual == "set" ? [0.0, 1.0, 1.5, 3.0] : [0.0] {
        usleep(useconds_t(pause * 1_000_000))
        let walker = Walker()
        let t0 = now()
        let root = walker.walk(win, at: 0)
        let ms = Int(now() - t0)
        if let b = best, walker.nodes <= b.walker.nodes, b.walker.nodes >= 20 { break }
        if best == nil || walker.nodes > best!.walker.nodes { best = (root, walker, ms) }
    }
    let (root, walker, ms) = best!
    // Open menus and popovers the app shows outside the window's own children.
    let attachedWalker = Walker()
    let attached = asElements(copyAttr(app, "AXChildren"))
        .filter { asString(copyAttr($0, "AXRole")) == "AXMenu" }
        .map { attachedWalker.walk($0, at: 0) }
    guard let frame = root.frame else { fail("the window has no frame", code: 6) }
    let walk = WalkStats(nodes: walker.nodes + attachedWalker.nodes, depth: max(walker.depth, attachedWalker.depth), ms: ms, capped: walker.capped || attachedWalker.capped)
    let running = NSRunningApplication(processIdentifier: pid)
    let version = running?.bundleURL.flatMap { Bundle(url: $0)?.infoDictionary?["CFBundleShortVersionString"] as? String } ?? "unknown"
    let shot = try await shoot(title: title, axFrame: frame, maxEdge: maxEdge, to: "\(out)/window.jpg")
    let v = ProcessInfo.processInfo.operatingSystemVersion
    let macos = "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    let recordedAt = ISO8601DateFormatter().string(from: Date())
    let windowMeta = WindowMeta(title: scrub(title), frame: frame)
    let tree = Tree(
        recordedAt: recordedAt, recorder: recorderVersion,
        app: AppMeta(name: running?.localizedName ?? need("app"), bundleId: running?.bundleIdentifier, version: version),
        os: "macOS \(macos)", window: windowMeta, scale: shot.scale, manualAccessibility: manual, walk: walk,
        root: root, attached: attached.isEmpty ? nil : attached)
    try write(tree, to: "\(out)/tree.json")
    var appshot = false
    if let path = one("appshot") {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any], let text = obj["text"] as? String else {
            fail("\(path) holds no axdump text", code: 7)
        }
        try (scrub(text) + "\n").write(toFile: "\(out)/appshot.txt", atomically: true, encoding: .utf8)
        appshot = true
    }
    let after = one("after-state").map { After(state: $0, action: need("after-action")) }
    let meta = Meta(
        app: need("app"), state: need("state"), recordedAt: recordedAt, recorder: recorderVersion, macos: macos,
        backingScale: shot.scale, window: windowMeta,
        shot: ShotMeta(file: "window.jpg", width: shot.width, height: shot.height, bytes: shot.bytes, maxEdge: maxEdge, scale: Double(shot.width) / frame.w, popups: shot.overlays > 0 ? shot.overlays : nil),
        walk: walk, setup: options["setup"] ?? [], after: after, appshot: appshot)
    try write(meta, to: "\(out)/meta.json")
    print("recorded \(need("app"))/\(need("state")): \(walk.nodes) nodes, depth \(walk.depth), \(ms) ms, \(shot.width)×\(shot.height) \(shot.bytes) B")
}

// MARK: - keys

let keyCodes: [String: CGKeyCode] = ["1": 18, "s": 1, "w": 13, "n": 45, "escape": 53, "return": 36, "tab": 48, "space": 49]

func postKey() {
    let name = need("key").lowercased()
    guard let code = keyCodes[name] else { fail("unknown key \(name)", code: 2) }
    var flags: CGEventFlags = []
    for m in (one("mods") ?? "").split(separator: ",") {
        switch m {
        case "cmd": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt": flags.insert(.maskAlternate)
        case "ctrl": flags.insert(.maskControl)
        default: fail("unknown modifier \(m)", code: 2)
        }
    }
    let src = CGEventSource(stateID: .privateState)
    for down in [true, false] {
        guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { fail("no key event", code: 5) }
        e.flags = flags
        e.postToPid(pid)
        usleep(20_000)
    }
}

// MARK: - main

guard AXIsProcessTrusted() else { fail("Accessibility is not granted to this process", code: 8) }

switch command {
case "record":
    guard CGPreflightScreenCaptureAccess() else { fail("Screen Recording is not granted to this process", code: 8) }
    try await record()
case "wait-window":
    let title = need("title")
    let until = now() + (Double(one("timeout") ?? "15") ?? 15) * 1000
    while window(titled: title) == nil {
        if now() > until { fail("no window titled \(title) after waiting", code: 3) }
        usleep(250_000)
    }
case "set-value":
    check(AXUIElementSetAttributeValue(requireElement(), "AXValue" as CFString, need("value") as CFString), "set AXValue")
case "select-range":
    let parts = need("range").split(separator: ",").compactMap { Int($0) }
    guard parts.count == 2 else { fail("--range is LOC,LEN", code: 2) }
    var range = CFRange(location: parts[0], length: parts[1])
    check(AXUIElementSetAttributeValue(requireElement(), "AXSelectedTextRange" as CFString, AXValueCreate(.cfRange, &range)!), "set AXSelectedTextRange")
case "insert-text":
    check(AXUIElementSetAttributeValue(requireElement(), "AXSelectedText" as CFString, need("text") as CFString), "set AXSelectedText")
case "press":
    check(AXUIElementPerformAction(requireElement(), (one("action") ?? "AXPress") as CFString), "perform")
case "wait-element":
    let until = now() + (Double(one("timeout") ?? "10") ?? 10) * 1000
    while (window(titled: need("title")).flatMap { find(in: $0, role: need("role"), subrole: one("subrole"), name: one("name")) }) == nil {
        if now() > until { fail("no \(need("role"))\(one("name").map { " named \($0)" } ?? "") after waiting", code: 4) }
        usleep(250_000)
    }
case "pick":
    // A popup's menu item by title, in the background. Prints the menu's first item as it
    // was before the pick (a save panel's current folder), so a caller can pick it back.
    let win = requireWindow()
    let popupName = need("popup")
    let popup = orFail(find(in: win, role: "AXPopUpButton", subrole: nil, name: popupName), "no popup named \(popupName)", code: 4)
    check(AXUIElementPerformAction(popup, "AXPress" as CFString), "open \(popupName)")
    let until = now() + 3000
    var menu: AXUIElement?
    while menu == nil, now() < until {
        menu = find(in: popup, role: "AXMenu", subrole: nil, name: nil)
        if menu == nil { usleep(100_000) }
    }
    guard let menu else { fail("\(popupName) opened no menu", code: 4) }
    let first = asElements(copyAttr(menu, "AXChildren")).first.flatMap { asString(copyAttr($0, "AXTitle")) } ?? ""
    let item = orFail(find(in: menu, role: "AXMenuItem", subrole: nil, name: need("item")), "no item \(need("item")) in \(popupName)", code: 4)
    check(AXUIElementPerformAction(item, "AXPress" as CFString), "pick \(need("item"))")
    print(first)
case "key":
    postKey()
default:
    fail("unknown command \(command)", code: 2)
}
