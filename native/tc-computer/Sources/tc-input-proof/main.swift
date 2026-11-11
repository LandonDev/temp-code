import AppKit
import ApplicationServices
import ComputerProtocol
import Foundation
import Input

// tc-input-proof: Input's live proof on scratch windows, never shipped (scripts/mac/input-proof.sh
// sets the windows up and cleans up).
//
//   tc-input-proof run --pids textedit=<pid>,chrome=<pid>[,tempcode=<pid>][,finder=<pid>][,intellij=<pid>] [--tiers ax,process] [--session] [--active] [--work <dir>] --report <path>
//
// The scratch apps are named by pid, never by bundle id: the person may have their own
// TextEdit or Electron windows open, and the proof never touches those.
//
// Tier 1 and 2 legs run any time and must leave the frontmost app and the pointer where they
// were. The session leg runs only after 2 minutes with no input from the person, checked again
// before every step, and otherwise reports "skipped: the person is active". The background
// fallbacks' legs (§24, FallbackLegs.swift) run last, at `ax` alone, on every scratch window:
// TextEdit's ⌘W among them closes its document.

func usage() -> Never {
    FileHandle.standardError.write(Data("usage: tc-input-proof run --pids textedit=<pid>,chrome=<pid>[,tempcode=<pid>][,finder=<pid>][,intellij=<pid>] [--tiers ax,process] [--session] [--active] [--work <dir>] --report <path>\n".utf8))
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
let wantActive = args.contains("--active")
let work = value("--work") ?? "/tmp/tc-input-proof/work"
guard let reportPath = value("--report") else { usage() }

let titles: [String: String] = ["textedit": "Untitled", "chrome": "Computer fixture form", "finder": "tc-input-finder"]
if pids.isEmpty { usage() }

NSApplication.shared.setActivationPolicy(.prohibited)

DispatchQueue.global(qos: .userInitiated).async { [pids, tiers, wantSession, wantActive, work, reportPath, titles] in
    let proof = Proof()
    var scratch: [String: Scratch] = [:]
    for (app, pid) in pids {
        if var s = Scratch.ready(app: app, pid: pid, title: titles[app]) {
            AXUIElementSetMessagingTimeout(s.window, 2)
            switch app {
            case "textedit": proof.textEdit(&s, tiers: tiers)
            case "chrome": proof.chrome(&s, tiers: tiers)
            case "tempcode": proof.tempcode(&s, tiers: tiers)
            // Finder and IntelliJ have the fallback legs alone
            default: break
            }
            if tiers.contains(.process), ["textedit", "chrome", "tempcode"].contains(app) { proof.probe(app, &s) }
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
    if wantActive {
        // §25: the front legs, before the fallbacks (TextEdit's ⌘W among those closes its document)
        for (app, _) in pids { if var s = scratch[app] { proof.active(app, &s, work: work) } }
    }
    if tiers.contains(.ax) {
        for (app, _) in pids { if var s = scratch[app] { proof.fallbacks(app, &s) } }
    }
    do { try proof.report.write(to: reportPath) } catch { FileHandle.standardError.write(Data("report: \(error)\n".utf8)) }
    let pass = proof.report.pass
    print(pass ? "input proof: pass" : "input proof: FAIL")
    DispatchQueue.main.async { exit(pass ? 0 : 1) }
}

NSApplication.shared.run()
