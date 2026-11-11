import AppKit
import ApplicationServices
import ComputerCore
import ComputerProtocol
import Foundation
import Input

/// The hand legs of the steps that need the app active (docs/computer-protocol.md §26, `--active`): each
/// runs at `front` only after five minutes with no input, else it is recorded "skipped: the person is
/// active", never passed. Each records its hold (`step.front`: activation, the step and its settle, the
/// restore) and checks the disk; whatever a leg moved on disk is put back.
extension Proof {
    static let activeIdleS: Double = 300
    static let activeTiers: [Tier] = [.ax, .process, .front]

    private func awayLongEnough(_ app: String, _ leg: String) -> Bool {
        if hidIdle() >= Self.activeIdleS { return true }
        var r = LegResult(app: app, leg: leg, tiers: Self.activeTiers.map(\.rawValue), ok: true, detail: "skipped: the person is active", ms: 0)
        r.skipped = "the person is active"
        report.legs.append(r)
        print("skip \(app) \(leg) · the person is active")
        return false
    }

    /// The hold as the report says it.
    static func hold(_ out: InputOutcome) -> String {
        guard let h = out.front else { return "no hold" }
        return "front activate \(h.activateMs) ms, held \(h.heldMs) ms, restore \(h.restoreMs) ms, total \(h.activateMs + h.heldMs + h.restoreMs) ms, \(h.restored.rawValue)"
    }

    private func mtime(_ path: String) -> Double? {
        (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date)?.timeIntervalSince1970
    }

    func active(_ app: String, _ s: inout Scratch, work: String) {
        switch app {
        case "textedit": activeTextEdit(&s, work: work)
        case "finder": activeFinder(&s)
        case "intellij":
            guard awayLongEnough(app, "active: Save All at front") else { return }
            step(app, "active: Save All at front", tiers: Self.activeTiers, ComputerAction(action: .key, text: "super+s"), allow: [.actionUnsupported], target: { s.target() }) { out in
                (out.tier == .front, Self.hold(out))
            }
        default: break
        }
    }

    /// TextEdit: where its untitled autosave lives, save_as into the scratch folder, then a typed line saved
    /// with ⌘S at front, and whether a click posted to its pid lands while it is active (§26.3's per-app fact).
    private func activeTextEdit(_ s: inout Scratch, work: String) {
        let app = "textedit"
        print("note textedit AXDocument before any save: \(P.string(s.window, "AXDocument") ?? "none")")
        let folder = (work as NSString).appendingPathComponent("active")
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        let path = (folder as NSString).appendingPathComponent("note.rtf")
        guard awayLongEnough(app, "active: save_as into the scratch folder") else { return }
        step(app, "active: save_as into the scratch folder", tiers: Self.activeTiers, ComputerAction(action: .saveAs, path: path), allow: [], target: { s.target() }) { out in
            let saved = out.disk?.saved ?? ""
            return (out.via == .panel && FileManager.default.fileExists(atPath: path), "\(saved) · \(Self.hold(out))")
        }
        guard let text = s.find("AXTextArea") else { return missing(app, "active: ⌘S at front", "text area") }
        let before = mtime(path)
        _ = P.set(text, "AXSelectedText", "a line saved at front\n" as CFString)
        guard awayLongEnough(app, "active: ⌘S at front") else { return }
        Thread.sleep(forTimeInterval: 1.1)
        step(app, "active: ⌘S at front", tiers: Self.activeTiers, ComputerAction(action: .key, text: "super+s"), allow: [], target: { s.target() }) { out in
            Thread.sleep(forTimeInterval: 0.5)
            let after = mtime(path)
            return (out.tier == .front && after != nil && after != before, "\(out.on ?? "") · mtime \(before ?? 0) → \(after ?? 0) · \(Self.hold(out))")
        }
        guard awayLongEnough(app, "active: a click posted to the active app's pid") else { return }
        let range0 = P.range(text)
        let f = P.frame(text) ?? s.frame
        let at = s.coordinate(CGPoint(x: f.x + 12, y: f.y + 8))
        step(app, "active: a click posted to the active app's pid", tiers: [.front], ComputerAction(action: .leftClick, coordinate: at), allow: [.needsTier], target: { s.target() }) { out in
            let moved = P.range(text) != range0
            return (true, "pid-posted click \(moved ? "honoured" : "ignored") while active · \(Self.hold(out))")
        }
    }

    /// Finder on the script's scratch folder: a rename by set_value then Return at front, New Folder,
    /// Move to Trash, each checked on disk and put back.
    private func activeFinder(_ s: inout Scratch) {
        let app = "finder"
        let folder = "/tmp/tc-input-finder"
        let names = ((try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []).filter { !$0.hasPrefix(".") }.sorted()
        guard let first = names.first else { return missing(app, "active: rename", "scratch file") }
        let renamed = "renamed-" + first
        if awayLongEnough(app, "active: rename by Return at front"), let field = P.walk(s.window).first(where: { P.string($0, "AXRole") == "AXTextField" && P.string($0, "AXValue") == first }) {
            step(app, "active: set the name (on screen only)", tiers: [.ax], ComputerAction(action: .setValue, value: renamed), allow: [.actionUnsupported], target: { s.target(field) }) { _ in
                (FileManager.default.fileExists(atPath: "\(folder)/\(first)"), "the file kept its name")
            }
            step(app, "active: rename by Return at front", tiers: Self.activeTiers, ComputerAction(action: .key, text: "Return"), allow: [], target: { s.target(field) }) { out in
                Thread.sleep(forTimeInterval: 0.5)
                let done = FileManager.default.fileExists(atPath: "\(folder)/\(renamed)")
                if done { try? FileManager.default.moveItem(atPath: "\(folder)/\(renamed)", toPath: "\(folder)/\(first)") }
                return (done, "renamed on disk, put back · \(Self.hold(out))")
            }
        }
        if awayLongEnough(app, "active: New Folder at front") {
            step(app, "active: New Folder at front", tiers: Self.activeTiers, ComputerAction(action: .key, text: "super+shift+n"), allow: [], target: { s.target() }) { out in
                Thread.sleep(forTimeInterval: 0.5)
                let made = ((try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []).filter { $0.hasPrefix("untitled folder") }
                for m in made { try? FileManager.default.removeItem(atPath: "\(folder)/\(m)") }
                return (!made.isEmpty, "\(made.joined(separator: ", ")) made, removed · \(Self.hold(out))")
            }
        }
        if awayLongEnough(app, "active: Move to Trash at front"), let last = names.last,
           let row = P.walk(s.window).first(where: { ["AXRow", "AXCell", "AXImage"].contains(P.string($0, "AXRole") ?? "") && P.names($0).contains(last.lowercased()) }) {
            _ = P.set(row, "AXSelected", kCFBooleanTrue)
            step(app, "active: Move to Trash at front", tiers: Self.activeTiers, ComputerAction(action: .key, text: "super+BackSpace"), allow: [], target: { s.target() }) { out in
                Thread.sleep(forTimeInterval: 0.5)
                let gone = !FileManager.default.fileExists(atPath: "\(folder)/\(last)")
                let trash = (NSHomeDirectory() as NSString).appendingPathComponent(".Trash/\(last)")
                if gone { try? FileManager.default.moveItem(atPath: trash, toPath: "\(folder)/\(last)") }
                return (gone, "moved to the Trash, put back · \(Self.hold(out))")
            }
        }
    }
}
