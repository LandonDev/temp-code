import Foundation
import TempCodeContract

/// The words and the arithmetic of the host detail's Activity sections
/// (Build, Mac bridge, Devices, Sync), pure, so the phone and the desktop say
/// the same thing and every sentence here has a test. Ports of the desktop's
/// own functions: src/shared/deployDrift.ts, src/renderer/src/lib/hostJobCard.ts,
/// contract-hostdevices.ts, contract-macbridge.ts, surfaces/MacBridgeSettings.tsx,
/// surfaces/harnessLine.ts and memoryLine.ts. Value code; nothing here touches
/// the main actor.

// MARK: - Build: master's release and the drift

/// Master's release.json as the phone last read it (deployDrift.ts `MasterRelease`).
public struct MasterRelease: Sendable, Hashable {
    /// release.json `n` on master.
    public var release: Int
    /// `1.0.N`.
    public var version: String
    /// Milliseconds.
    public var fetchedAt: Double

    public init(release: Int, version: String, fetchedAt: Double) {
        self.release = release
        self.version = version
        self.fetchedAt = fetchedAt
    }

    /// release.json's `n` (a positive integer); nil for bad JSON or JSON without one.
    public static func parse(_ data: Data, now: Double) -> MasterRelease? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let n: Int? = switch object["n"] {
        case let value as Int: value
        case let value as Double where value == value.rounded(): Int(value)
        default: nil
        }
        guard let n, n > 0 else { return nil }
        return MasterRelease(release: n, version: "1.0.\(n)", fetchedAt: now)
    }
}

/// How far a host runs behind master (deployDrift.ts `behindCount`, `driftMark`).
public enum DriftLine {
    /// `master − running`, floored at zero; nil until both are known.
    public static func behind(master: Int?, running: Int?) -> Int? {
        guard let master, let running else { return nil }
        return max(0, master - running)
    }

    /// `+3`; nil when current or unknown.
    public static func mark(behind: Int?) -> String? {
        guard let behind, behind > 0 else { return nil }
        return "+\(behind)"
    }

    /// "3 releases behind master".
    public static func accessibilityLabel(behind: Int) -> String {
        "\(behind) \(behind == 1 ? "release" : "releases") behind master"
    }

    /// The Build section's footer. Behind: the count and both versions, then
    /// what brings the host up: the Mac's publish, deploying from here, or
    /// the admin key a lesser key lacks; nothing more when the box cannot
    /// take a deploy right now (the row's own line says why). Current: one
    /// sentence. Master unknown: a sentence only when a fetch failed and
    /// nothing is held, so the footer is silent before the first fetch. No
    /// build in the hello (an older host): nil.
    public static func footer(build: BuildFacts?, master: MasterRelease?, fetchFailed: Bool, canDeploy: Bool, isAdmin: Bool) -> String? {
        guard let build else { return nil }
        guard let master else { return fetchFailed ? "Master's version could not be read." : nil }
        let behind = behind(master: master.release, running: build.release) ?? 0
        if behind == 0 { return "Up to date with master (v\(master.version))." }
        let count = "\(behind) \(behind == 1 ? "release" : "releases") behind master: v\(build.version) → v\(master.version)."
        let fix: String = if build.platform == "darwin" {
            " Publish from the Mac."
        } else if !isAdmin {
            " Deploying needs an admin key."
        } else if canDeploy {
            " Deploy from here."
        } else {
            ""
        }
        return count + fix
    }
}

// MARK: - Deploy: the confirm, the row line, the log card

/// The desktop's `versionText`: "1.0.3" and "v1.0.3" both read "v1.0.3"; empty or nil is nil.
func versionText(_ v: String?) -> String? {
    guard let v, !v.isEmpty else { return nil }
    return v.hasPrefix("v") ? v : "v\(v)"
}

/// `1.0.N` or `v1.0.N` → N; anything else nil.
func releaseN(_ version: String?) -> Int? {
    guard let version else { return nil }
    let body = version.hasPrefix("v") ? String(version.dropFirst()) : version
    guard body.hasPrefix("1.0.") else { return nil }
    let digits = body.dropFirst(4)
    guard !digits.isEmpty, digits.allSatisfy(\.isNumber) else { return nil }
    return Int(digits)
}

public enum DeployWords {
    /// The confirm's message (hostJobCard.ts `deployConfirmText`), word for word.
    public static func confirm(hostName: String, deployed: String?, master: String?) -> String {
        let from = versionText(deployed)
        let to = versionText(master)
        if let from, let to, let a = releaseN(deployed), let b = releaseN(master) {
            let n = b - a
            if n > 0 {
                return "\(from) → \(to), \(n) \(n == 1 ? "release" : "releases"). \(hostName) rebuilds master, trials it and restarts; it rolls back if the trial fails."
            }
            if n == 0 {
                return "\(hostName) already runs \(to). Deploying rebuilds master from GitHub and restarts the service anyway."
            }
            return "\(from) → \(to): master is behind what \(hostName) runs. Deploying rebuilds master and restarts the service."
        }
        if let from {
            return "\(hostName) runs \(from). Deploying rebuilds master from GitHub, trials it and restarts the service."
        }
        return "\(hostName) rebuilds master from GitHub, trials it and restarts the service; it rolls back if the trial fails."
    }

    /// The line under a box's row (hostJobCard.ts `deployRowLine`): "Runs
    /// v1.0.270, deploying", "Runs v1.0.273, up to date with master".
    public static func rowLine(installed: Bool, version: String?, masterVersion: String?, connected: Bool, phase: HostJobPhase) -> String {
        if !connected { return "Not connected right now." }
        if !installed { return "Deploy from the app is not installed on this host." }
        let runs = versionText(version)
        let behind: Int? = if let a = releaseN(version), let b = releaseN(masterVersion) { b - a } else { nil }
        if phase == .pending || phase == .running { return "Runs \(runs ?? "an unknown version"), deploying" }
        guard let behind else { return "Runs \(runs ?? "an unknown version")." }
        if behind <= 0 { return "Runs \(runs ?? "an unknown version"), up to date with master" }
        return "Runs \(runs ?? "an unknown version"), \(behind) \(behind == 1 ? "release" : "releases") behind master"
    }
}

/// The deploy row's and the log sheet's one derived state (hostJobCard.ts
/// `hostJobCard`, the deploy job alone: the Mac's publish never reaches the
/// phone). Idle is invisible.
public struct HostJobCard: Sendable, Hashable {
    public struct Ending: Sendable, Hashable {
        public var text: String
        public var failed: Bool

        public init(text: String, failed: Bool) {
            self.text = text
            self.failed = failed
        }
    }

    public var visible: Bool
    public var phase: HostJobPhase
    public var title: String
    /// The quiet line beside the title.
    public var note: String?
    /// The last `LogTail.lines` lines.
    public var lines: [String]
    /// The deploy cannot be stopped once the trigger has it; a status that could would say so here.
    public var stoppable: Bool
    /// The closing line once done.
    public var ending: Ending?

    public static func deploy(status: HostJobStatus, text: String, hostName: String, linkUp: Bool, deployedVersion: String?) -> HostJobCard {
        let lines = LogTail.tail(text)
        let what = status.target ?? "master"
        let base = HostJobCard(visible: true, phase: status.phase, title: "", note: nil, lines: lines, stoppable: false, ending: nil)
        switch status.phase {
        case .idle, .unknown:
            return HostJobCard(visible: false, phase: .idle, title: "", note: nil, lines: lines, stoppable: false, ending: nil)
        case .pending:
            var card = base
            card.title = "Deploying \(what) to \(hostName)"
            card.note = "Waiting for the trigger on the box"
            return card
        case .running:
            var card = base
            card.title = "Deploying \(what) to \(hostName)"
            card.note = linkUp ? "Cannot be stopped mid-way; the box rolls back on failure" : "The box is restarting; the log continues when it is back"
            return card
        case .done:
            var card = base
            if status.exit == 0 {
                card.title = "Deployed \(what) to \(hostName)"
                card.ending = Ending(text: "Deployed \(versionText(deployedVersion) ?? what), the service is back", failed: false)
            } else {
                card.title = "Deploy of \(what) to \(hostName)"
                card.ending = Ending(text: status.exit.map { "Deploy failed (exit \($0))" } ?? "Deploy did not start", failed: true)
            }
            return card
        }
    }
}

/// The log's tail (hostJobCard.ts `tailLines`) and the `host-log` push's semantics.
public enum LogTail {
    public static let lines = 40

    /// At most `lines` lines of `text`, a trailing newline dropped.
    public static func tail(_ text: String, lines count: Int = lines) -> [String] {
        var all = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if all.last == "" { all.removeLast() }
        return all.count > count ? Array(all.suffix(count)) : all
    }

    /// `reset` drops what was shown; `append` adds to it.
    public static func apply(_ text: String, append: String?, reset: Bool) -> String {
        (reset ? "" : text) + (append ?? "")
    }

    /// Keeps the newest `lines` lines in memory (the sheet shows `tail` of it anyway).
    public static func cap(_ text: String, lines count: Int) -> String {
        let all = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard all.count > count else { return text }
        return all.suffix(count).joined(separator: "\n")
    }
}

// MARK: - Devices

/// A device's state as a row says it: the dot's tone, what the device is
/// doing (the row's second line) and what it is (after it, a step quieter).
public struct DeviceState: Sendable, Hashable {
    public enum Tone: Sendable, Hashable {
        /// Booted, connected.
        case on
        /// Booting, shutting down, paired but away.
        case between
        /// Shut down, unavailable.
        case off
    }

    public var tone: Tone
    /// "Booted, 34% CPU", "Shut down", "Connected over USB".
    public var status: String
    /// "iOS 26.0"; a phone's model first: "iPhone 16 Pro, iOS 26.0".
    public var platform: String

    public init(tone: Tone, status: String, platform: String) {
        self.tone = tone
        self.status = status
        self.platform = platform
    }

    /// Both parts as one phrase, for VoiceOver: "Booted, 34% CPU, iOS 26.0".
    public var spoken: String { "\(status), \(platform)" }
}

public enum DeviceWords {
    /// The footer's first line, in sentences: "3 simulators, 1 booted. iPhone
    /// 16 Pro connected. Load 2.1 on 10 cores." (contract-hostdevices.ts `devicesSummary`).
    public static func summary(_ report: HostDevicesReport) -> String {
        var parts: [String] = []
        let sims = report.simulators.count
        let booted = report.simulators.filter { $0.state == .booted }.count
        parts.append(sims == 0 ? "No simulators" : "\(sims) \(sims == 1 ? "simulator" : "simulators")\(booted > 0 ? ", \(booted) booted" : "")")
        let connected = report.phones.filter { $0.connection == .connected }
        let paired = report.phones.filter { $0.connection != .connected }
        if !connected.isEmpty {
            parts.append("\(connected.map(\.model).joined(separator: ", ")) connected")
        } else if !paired.isEmpty {
            parts.append("\(paired.count == 1 ? paired[0].model : "\(paired.count) iPhones") paired")
        }
        parts.append("Load \(String(format: "%.1f", report.load.oneMinute)) on \(report.load.cores) cores")
        return parts.map { "\($0)." }.joined(separator: " ")
    }

    /// "Home, running" (`holderText`).
    public static func holder(_ holder: DeviceHolder) -> String {
        if let status = holder.status, !status.isEmpty { return "\(holder.title), \(status)" }
        return holder.title
    }

    /// The confirm before a simulator is deleted (`deleteSimulatorConfirm`).
    public static func deleteConfirm(_ sim: Simulator) -> (title: String, body: String) {
        let title = "Delete \(sim.name)?"
        if let holder = sim.holder { return (title, "Held by \(Self.holder(holder)). Delete anyway?") }
        return (title, "\(sim.name) (\(sim.runtime)) and its data are removed from this Mac.")
    }

    /// "Booted, 34% CPU", "Shut down", "Booting"; the platform is the runtime.
    public static func simulatorState(_ sim: Simulator) -> DeviceState {
        switch sim.state {
        case .booted:
            let cpu = sim.cpu.map { ", \(Int($0.rounded()))% CPU" } ?? ""
            return DeviceState(tone: .on, status: "Booted\(cpu)", platform: sim.runtime)
        case .shutdown:
            return DeviceState(tone: .off, status: "Shut down", platform: sim.runtime)
        case .other, .unknown:
            let word = sim.stateText.flatMap { $0.isEmpty ? nil : $0 } ?? "Changing"
            return DeviceState(tone: .between, status: word, platform: sim.runtime)
        }
    }

    /// "Connected over USB", "Paired", "Unavailable"; the platform is
    /// "iPhone 16 Pro, iOS 26.0".
    public static func phoneState(_ phone: Phone) -> DeviceState {
        let platform = "\(phone.model), \(phone.os)"
        switch phone.connection {
        case .connected:
            let transport = phone.transport.map { " over \($0)" } ?? ""
            return DeviceState(tone: .on, status: "Connected\(transport)", platform: platform)
        case .paired:
            return DeviceState(tone: .between, status: "Paired", platform: platform)
        case .unavailable, .unknown:
            return DeviceState(tone: .off, status: "Unavailable", platform: platform)
        }
    }

    /// "Xcode-beta 27.0", "Xcode", or "No Xcode found": the Xcode the Mac's tools run under.
    /// The load is the summary's; it is not said twice.
    public static func xcodeLine(_ xcode: XcodeInfo?) -> String {
        guard let xcode else { return "No Xcode found" }
        return xcode.version.map { "\(xcode.name) \($0)" } ?? xcode.name
    }
}

// MARK: - The Mac bridge

public enum MacBridgeWords {
    /// 1 → 1st, 2 → 2nd, 3 → 3rd, 11 → 11th, 22 → 22nd (contract-macbridge.ts `ordinal`).
    public static func ordinal(_ n: Int) -> String {
        let tens = n % 100
        if tens >= 11 && tens <= 13 { return "\(n)th" }
        return switch n % 10 {
        case 1: "\(n)st"
        case 2: "\(n)nd"
        case 3: "\(n)rd"
        default: "\(n)th"
        }
    }

    /// 16 → "16", 4.5 → "4.5" (`trimNumber`).
    public static func trim(_ n: Double) -> String {
        n == n.rounded() ? String(Int(n)) : String(format: "%.1f", n)
    }

    /// "3rd in line for the Mac (load 12.3 of 8)", "2nd in line for the Mac
    /// (4 of 4 running)" (`heldLine`).
    public static func heldLine(_ held: MacBridgeHeld) -> String {
        let why = held.reason == .load
            ? "load \(String(format: "%.1f", held.load)) of \(trim(held.limit))"
            : "\(held.running) of \(held.maxRunning) running"
        return "\(ordinal(held.position)) in line for the Mac (\(why))"
    }

    /// A call's title: the command (or its argv joined) for a run; the path's
    /// last two components for a read; the path with "(write)" for a write.
    public static func commandLine(_ call: MacBridgeCall) -> String {
        switch call.kind {
        case .run, .unknown:
            if let command = call.command, !command.isEmpty { return command }
            if let argv = call.argv, !argv.isEmpty { return argv.joined(separator: " ") }
            return call.method.rawValue
        case .read:
            return shortPath(call.path) ?? call.method.rawValue
        case .write:
            return "\(call.path ?? call.method.rawValue) (write)"
        }
    }

    /// The last two components of a path: "temp-code/package.json".
    static func shortPath(_ path: String?) -> String? {
        guard let path, !path.isEmpty else { return nil }
        let parts = path.split(separator: "/").map(String.init)
        return parts.suffix(2).joined(separator: "/")
    }

    /// "1 running, 2 waiting and 1 thread", else "Nothing running" (MacBridgeSettings.tsx `usageNow`).
    public static func usage(_ host: MacBridgeActivityHost) -> String {
        var parts: [String] = []
        if host.running > 0 { parts.append("\(host.running) running") }
        if host.held > 0 { parts.append("\(host.held) waiting") }
        if host.threads > 0 { parts.append("\(host.threads) \(host.threads == 1 ? "thread" : "threads")") }
        guard let last = parts.popLast() else { return "Nothing running" }
        return parts.isEmpty ? last : "\(parts.joined(separator: ", ")) and \(last)"
    }

    /// "Load 12.3 of 32 on 16 cores", and while busy ", holding new commands until under 24".
    public static func loadLine(_ load: MacBridgeLoad) -> String {
        let base = "Load \(String(format: "%.1f", load.load)) of \(trim(load.limit)) on \(load.cores) cores"
        return load.busy ? "\(base), holding new commands until under \(trim(load.resumeBelow))" : base
    }

    /// "Holding new commands until under 24" while the guard holds for load; nil otherwise.
    public static func holdingLine(_ load: MacBridgeLoad) -> String? {
        load.busy ? "Holding new commands until under \(trim(load.resumeBelow))" : nil
    }

    /// "12.3 of 32": the Load row's value.
    public static func loadValue(_ load: MacBridgeLoad) -> String {
        "\(String(format: "%.1f", load.load)) of \(trim(load.limit))"
    }

    /// "2 commands wait for a decision on Studio; approve them there."; nil when none.
    public static func pendingFooter(pending: Int, macName: String) -> String? {
        guard pending > 0 else { return nil }
        return "\(pending) \(pending == 1 ? "command waits" : "commands wait") for a decision on \(macName); approve \(pending == 1 ? "it" : "them") there."
    }

    /// Running first, then held, then paused; oldest first within a status.
    public static func sorted(_ calls: [MacBridgeCall]) -> [MacBridgeCall] {
        func rank(_ status: MacBridgeCall.Status) -> Int {
            switch status {
            case .running: 0
            case .held: 1
            case .paused: 2
            case .unknown: 3
            }
        }
        return calls.sorted { (rank($0.status), $0.createdAt) < (rank($1.status), $1.createdAt) }
    }
}

// MARK: - Sync

public enum SyncWords {
    /// The harness line (harnessLine.ts): syncing, the error, never, or files
    /// and when. Whether the peer is connected is the row's to say, once.
    public static func harnessLine(_ env: HarnessEnvironmentStatus, now: Double) -> String {
        if env.running { return "Harness config: syncing…" }
        if let error = env.error, !error.isEmpty {
            let last = env.syncedAt.map { " (last synced \(ago(Double($0), now: now)))" } ?? ""
            return "Harness config: \(error)\(last)"
        }
        guard let syncedAt = env.syncedAt else {
            return "Harness config: never synced"
        }
        let files = env.files ?? 0
        return "Harness config: \(files) \(files == 1 ? "file" : "files")\(setsLine(env.sets)), synced \(ago(Double(syncedAt), now: now))"
    }

    /// " (Claude skills 80, Codex hooks 1)": the sets with files, in the sender's order; nothing for an older sender.
    public static func setsLine(_ sets: [String: Int]?) -> String {
        guard let sets else { return "" }
        let parts = sets.sorted { $0.key < $1.key }.filter { $0.value > 0 }.map { "\($0.key) \($0.value)" }
        return parts.isEmpty ? "" : " (\(parts.joined(separator: ", ")))"
    }

    /// The memory line (memoryLine.ts); like the harness line, it leaves the connection to the row.
    public static func memoryLine(_ env: MemoryEnvironmentStatus, now: Double) -> String {
        if env.running { return "Memory: syncing…" }
        if let error = env.error, !error.isEmpty {
            let last = env.syncedAt.map { " (last synced \(ago(Double($0), now: now)))" } ?? ""
            return "Memory: \(error)\(last)"
        }
        guard let syncedAt = env.syncedAt else {
            return "Memory: never synced"
        }
        let files = env.files ?? 0
        let conflicts = env.conflicts > 0 ? ", \(env.conflicts) \(env.conflicts == 1 ? "conflict" : "conflicts")" : ""
        return "Memory: \(files) \(files == 1 ? "file" : "files"), synced \(ago(Double(syncedAt), now: now))\(conflicts)"
    }

    /// "box's copy, 2h ago".
    public static func conflictLine(_ conflict: MemoryConflict, now: Double) -> String {
        "\(conflict.host)'s copy, \(ago(Double(conflict.at), now: now))"
    }

    /// `TimeFormat.ago` as a phrase: "just now", "3m ago", "Oct 3".
    public static func ago(_ at: Double, now: Double) -> String {
        let text = TimeFormat.ago(Int(at), now: Date(timeIntervalSince1970: now / 1000))
        if text == "now" || text.isEmpty { return "just now" }
        return text.last?.isNumber == false ? "\(text) ago" : text
    }

    /// "3 conflict copies".
    public static func conflictsTitle(_ count: Int) -> String {
        "\(count) conflict \(count == 1 ? "copy" : "copies")"
    }

    /// The section's footer: the one-sentence rule when sync is on, else that it is off, and what stayed behind.
    public static func footer(enabled: Bool, skipped: Int) -> String {
        let base = enabled
            ? "Skills, commands, hooks and settings go from the Mac to its hosts; memory crosses both ways, the newer copy wins."
            : "Sync is off on this host."
        guard skipped > 0 else { return base }
        return "\(base) \(skipped) \(skipped == 1 ? "file stays" : "files stay") on this host (over 16 MB, a symlink out of reach, or a macOS binary)."
    }
}

// MARK: - What a key may do here

/// Which key a section's control needs, and the sentence shown when the key lacks it.
public enum HostExtrasAccess: Sendable, Hashable, CaseIterable {
    case deploy
    case sync
    case deviceActions
    case macStop

    public var needs: Capability {
        switch self {
        case .deploy, .sync: .admin
        case .deviceActions, .macStop: .operate
        }
    }

    public var reason: String {
        switch self {
        case .deploy: "Deploying needs an admin key."
        case .sync: "Reading the sync state needs an admin key."
        case .deviceActions: "Shutting down or deleting a simulator needs an operate key."
        case .macStop: "Stopping a command needs an operate key on the Mac."
        }
    }

    public func allowed(_ environment: PairedEnvironment) -> Bool {
        environment.allows(needs)
    }
}

/// Up to two sentences on one line; a third starts a second line, never more.
public enum FooterLines {
    public static func join(_ sentences: [String?]) -> [String] {
        let kept = sentences.compactMap { $0 }.filter { !$0.isEmpty }
        guard kept.count > 2 else { return kept.isEmpty ? [] : [kept.joined(separator: " ")] }
        return [kept.prefix(2).joined(separator: " "), kept.dropFirst(2).joined(separator: " ")]
    }
}
