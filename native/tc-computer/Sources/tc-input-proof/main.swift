import AppKit
import ApplicationServices
import ComputerProtocol
import Foundation
import Input

// tc-input-proof: Input's live proof on scratch windows, never shipped (scripts/mac/input-proof.sh
// sets the windows up and cleans up).
//
//   tc-input-proof run --pids textedit=<pid>,chrome=<pid>[,tempcode=<pid>] [--tiers ax,process] [--session] --report <path>
//
// The scratch apps are named by pid, never by bundle id: the person may have their own
// TextEdit or Electron windows open, and the proof never touches those.
//
// Tier 1 and 2 legs run any time and must leave the frontmost app and the pointer where they
// were. The session leg runs only after 2 minutes with no input from the person, checked again
// before every step, and otherwise reports "skipped: the person is active".

func usage() -> Never {
    FileHandle.standardError.write(Data("usage: tc-input-proof run --pids textedit=<pid>,chrome=<pid>[,tempcode=<pid>] [--tiers ax,process] [--session] --report <path>\n".utf8))
    exit(2)
}

let args = Array(CommandLine.arguments.dropFirst())
guard args.first == "run" else { usage() }
func value(_ flag: String) -> String? {
    args.firstIndex(of: flag).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
}
let pids: [(String, pid_t)] = (value("--pids") ?? "").split(separator: ",").compactMap { part in
    let kv = part.split(separator: "=")
    guard kv.count == 2, let pid = pid_t(kv[1]) else { return nil }
    return (String(kv[0]), pid)
}
let tiers = (value("--tiers") ?? "ax,process").split(separator: ",").map { Tier(rawValue: String($0)) }
let wantSession = args.contains("--session")
guard let reportPath = value("--report") else { usage() }

let titles: [String: String] = ["textedit": "Untitled", "chrome": "Computer fixture form"]
if pids.isEmpty { usage() }

NSApplication.shared.setActivationPolicy(.prohibited)

DispatchQueue.global(qos: .userInitiated).async { [pids, tiers, wantSession, reportPath, titles] in
    let proof = Proof()
    var scratch: [String: Scratch] = [:]
    for (app, pid) in pids {
        if var s = Scratch.open(pid: pid, title: titles[app]) {
            AXUIElementSetMessagingTimeout(s.window, 2)
            switch app {
            case "textedit": proof.textEdit(&s, tiers: tiers)
            case "chrome": proof.chrome(&s, tiers: tiers)
            default: proof.tempcode(&s, tiers: tiers)
            }
            if tiers.contains(.process) { proof.probe(app, &s) }
            scratch[app] = s
        } else {
            proof.missing(app, "setup", "scratch window")
        }
    }
    proof.compareProbes()
    if wantSession, var te = scratch["textedit"] {
        var ch = scratch["chrome"]
        proof.session(textEdit: &te, chrome: &ch)
    }
    do { try proof.report.write(to: reportPath) } catch { FileHandle.standardError.write(Data("report: \(error)\n".utf8)) }
    let pass = proof.report.legs.allSatisfy { $0.ok || $0.skipped != nil }
    print(pass ? "input proof: pass" : "input proof: FAIL")
    DispatchQueue.main.async { exit(pass ? 0 : 1) }
}

NSApplication.shared.run()
