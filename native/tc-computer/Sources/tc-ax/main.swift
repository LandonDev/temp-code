// tc-ax: the AX reader's dev tool for the live proof and the timings
// (scripts/mac/ax-reader-proof.sh, plan §6.1 and §7.4). Never shipped.
//
//   tc-ax observe --pid <p> --expect-title <t> [--mode full|auto] [--menus] [--geometry] [--budget <n>] [--element <i>]
//   tc-ax session --pid <p> --expect-title <t>      JSON lines in, JSON lines out (see Live.swift)
//   tc-ax bench   --pid <p> --expect-title <t> [--reads 20] [--warm 2] [--mode full|auto] [--signature 50] [--budget <n>]
//   tc-ax windows --pid <p>                          the pid's window titles
//   tc-ax tabs    --pid <p>                          each window's tabs (a Chromium app's browser windows, §25.4)
//   tc-ax select-tab <tab title> --pid <p> --expect-title <t> [--tabs any]   select that tab of the window (§25.4)
//   tc-ax page    --pid <p> --expect-title <t>      the window's page state and header line (§25.2)
//   tc-ax replay  <tree.json> [--reads 20] [--budget <n>] [--print]   a recorded tree through the builder (buildMs); runs anywhere
//   tc-ax replay  --synthetic <nodes> [--reads 20]          a synthetic tree of that many nodes
//
// Live commands read only a pid named in TC_AX_ALLOW_PIDS (comma-separated) and
// only the one window whose title is exactly --expect-title (narrowed by
// --window-id <id>, and with --contains AXRole=Name to the one holding such an
// element); they never raise or activate a window.
import AXText
import ComputerProtocol
import Foundation

struct Args {
    var command: String
    var positional: [String] = []
    var options: [String: String] = [:]
    var flags: Set<String> = []

    init(_ argv: [String]) {
        command = argv.first ?? "help"
        var rest = argv.dropFirst()[...]
        while let a = rest.popFirst() {
            guard a.hasPrefix("--") else {
                positional.append(a)
                continue
            }
            let name = String(a.dropFirst(2))
            if ["menus", "geometry", "print"].contains(name) { flags.insert(name) } else { options[name] = rest.popFirst() ?? "" }
        }
    }

    func int(_ name: String, _ fallback: Int) -> Int { options[name].flatMap(Int.init) ?? fallback }
}

func emit<T: Encodable>(_ value: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = (try? encoder.encode(value)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func fail(_ message: String, code: Int32 = 2) -> Never {
    FileHandle.standardError.write(Data("tc-ax: \(message)\n".utf8))
    exit(code)
}

struct Spread: Encodable {
    var p50: Double
    var p95: Double

    init(_ values: [Double]) {
        let v = values.sorted()
        guard !v.isEmpty else {
            p50 = 0
            p95 = 0
            return
        }
        let round = { (x: Double) in (x * 100).rounded() / 100 }
        p50 = round(v[(v.count - 1) / 2])
        p95 = round(v[max(0, Int((Double(v.count) * 0.95).rounded(.up)) - 1)])
    }
}

func ms(since start: ContinuousClock.Instant) -> Double { Double((ContinuousClock.now - start) / .microseconds(1)) / 1_000 }

/// A synthetic window of `count` nodes: nested groups of buttons, texts and inputs, a long list.
func synthetic(_ count: Int) -> AXSnapshot {
    var next: NodeID = 1
    func id() -> NodeID {
        next += 1
        return next
    }
    let frame = Rect(x: 0, y: 0, w: 1440, h: 900)
    var made = 1
    var sections: [AXNode] = []
    while made < count {
        var items: [AXNode] = []
        for i in 0..<20 where made < count {
            made += 1
            switch i % 4 {
            case 0: items.append(AXNode(id: id(), role: "AXButton", title: "Button \(made)", frame: Rect(x: 10, y: 10, w: 80, h: 20), actions: ["AXPress"]))
            case 1: items.append(AXNode(id: id(), role: "AXStaticText", value: .string("Paragraph \(made) of the synthetic page"), frame: Rect(x: 10, y: 40, w: 300, h: 20)))
            case 2: items.append(AXNode(id: id(), role: "AXTextField", title: "Field \(made)", value: .string("value \(made)"), frame: Rect(x: 10, y: 70, w: 200, h: 20), settable: ["AXValue"]))
            default: items.append(AXNode(id: id(), role: "AXGroup", frame: Rect(x: 10, y: 100, w: 300, h: 20), children: [AXNode(id: id(), role: "AXLink", title: "Link \(made)", frame: Rect(x: 10, y: 100, w: 60, h: 20), actions: ["AXPress"])]))
                made += 1
            }
        }
        made += 1
        sections.append(AXNode(id: id(), role: "AXGroup", title: "Section \(sections.count)", frame: frame, children: items))
    }
    let window = AXNode(id: 1, role: "AXWindow", title: "Synthetic", frame: frame, children: sections)
    let info = WindowInfo(id: 1, title: "Synthetic", frame: frame, main: true, focused: true, minimized: false, onScreen: true, space: .current)
    return AXSnapshot(app: AppFacts(pid: 0, bundleId: nil, name: "Synthetic"), window: info, roots: [window])
}

/// The builder alone over a recorded or synthetic tree: what `Builder.build` costs.
func replay(_ args: Args) {
    let snapshot: AXSnapshot
    var space = CoordinateSpace(width: 1280, height: 800, scale: 1)
    if let n = args.options["synthetic"].flatMap(Int.init) {
        snapshot = synthetic(n)
    } else {
        guard let path = args.positional.first, let data = FileManager.default.contents(atPath: path), let tree = try? RawTree.decode(data) else {
            fail("replay needs a tree.json or --synthetic <nodes>")
        }
        snapshot = RawTree.snapshot(tree, ids: NodeIDSource())
        let scale = min(1, 1280 / max(tree.window.frame.w, tree.window.frame.h)) * tree.scale
        space = CoordinateSpace(width: Int((tree.window.frame.w * scale).rounded()), height: Int((tree.window.frame.h * scale).rounded()), scale: scale)
    }
    let request = BuildRequest(budgetBytes: args.int("budget", ComputerDefaults.ObservationBudget.defaultBytes), space: space)
    var times: [Double] = []
    var last: Built?
    for _ in 0..<args.int("reads", 20) {
        let book = IndexBook(allocator: IndexAllocator())
        let start = ContinuousClock.now
        last = Builder.build(snapshot, request, book: book, base: nil).0
        times.append(ms(since: start))
    }
    struct Out: Encodable { var nodes: Int; var kept: Int; var bytes: Int; var omitted: Int; var buildMs: Spread }
    var nodes = 0
    func count(_ n: AXNode) {
        nodes += 1
        n.children.forEach(count)
    }
    snapshot.roots.forEach(count)
    emit(Out(nodes: nodes, kept: last?.stats.elements ?? 0, bytes: last?.stats.bytes ?? 0, omitted: last?.stats.omitted ?? 0, buildMs: Spread(times)))
    if args.flags.contains("print"), let text = last?.text { print(text) }
}

let args = Args(Array(CommandLine.arguments.dropFirst()))
switch args.command {
case "replay":
    replay(args)
default:
    #if canImport(ApplicationServices)
    Live.run(args)
    #else
    fail("\(args.command) reads live windows: the Mac only", code: 64)
    #endif
}
