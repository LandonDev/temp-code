import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private let now: Double = 1_700_000_000_000
private func build(release: Int, platform: String = "linux") -> HelloPush.Build {
    HelloPush.Build(release: release, version: "1.0.\(release)", sha: nil, platform: platform)
}
private func master(_ n: Int) -> MasterRelease { MasterRelease(release: n, version: "1.0.\(n)", fetchedAt: now) }
private func jobStatus(_ phase: HostJobPhase, target: String? = "master", exit: Int? = nil) -> HostJobStatus {
    HostJobStatus(job: .deploy, phase: phase, target: target, startedAt: nil, finishedAt: nil, exit: exit, stoppable: false)
}
private func simulator(_ name: String, state: SimulatorState, cpu: Double? = nil, stateText: String? = nil, holder: DeviceHolder? = nil) -> Simulator {
    Simulator(udid: name, name: name, runtime: "iOS 26.0", state: state, stateText: stateText, cpu: cpu, holder: holder)
}
private func phone(_ model: String, _ connection: PhoneConnection, transport: String? = nil) -> Phone {
    Phone(udid: model, name: model, model: model, os: "iOS 26.0", connection: connection, transport: transport, holder: nil)
}
private func report(sims: [Simulator], phones: [Phone], load: Double = 2.1, cores: Int = 10) -> HostDevicesReport {
    HostDevicesReport(environmentId: "env_mac", at: now, simulators: sims, phones: phones, xcode: nil, load: HostLoad(oneMinute: load, cores: cores), problems: [])
}
private func held(reason: MacBridgeHeld.Reason, position: Int) -> MacBridgeHeld {
    MacBridgeHeld(reason: reason, position: position, load: 12.3, limit: 8, cores: 4, maxRunning: 4, running: 4)
}
private func call(kind: MacBridgeCall.Kind, status: MacBridgeCall.Status, command: String? = nil, argv: [String]? = nil, path: String? = nil, createdAt: Int = 0) -> MacBridgeCall {
    MacBridgeCall(id: "\(kind)-\(status)-\(createdAt)", environmentId: "env_box", hostName: "box", sessionId: "s1", threadTitle: "t", kind: kind, method: .macRun, command: command, argv: argv, cwd: nil, path: path, status: status, held: nil, interactive: nil, createdAt: createdAt)
}
private func harness(running: Bool = false, error: String? = nil, syncedAt: Int? = nil, files: Int? = nil, sets: [String: Int]? = nil, connected: Bool = true) -> HarnessEnvironmentStatus {
    HarnessEnvironmentStatus(id: "env_box", name: "box", connected: connected, running: running, files: files, sets: sets, syncedAt: syncedAt, lastAttemptAt: nil, error: error)
}
private func memory(running: Bool = false, error: String? = nil, syncedAt: Int? = nil, files: Int? = nil, conflicts: Int = 0, connected: Bool = true) -> MemoryEnvironmentStatus {
    MemoryEnvironmentStatus(id: "env_box", name: "box", connected: connected, running: running, files: files, syncedAt: syncedAt, lastAttemptAt: nil, error: error, conflicts: conflicts)
}
private func environment(caps: [Capability]) -> PairedEnvironment {
    PairedEnvironment(id: "env_test", name: "box", origin: URL(string: "https://box.example")!, caps: caps, keyId: "K1", keyName: "iphone", addedAt: 0)
}

@Suite("MasterRelease.parse")
struct MasterReleaseParseTests {
    @Test func `real release.json text`() {
        let parsed = MasterRelease.parse(Data(#"{"n": 273, "notes": "x"}"#.utf8), now: now)
        #expect(parsed == MasterRelease(release: 273, version: "1.0.273", fetchedAt: now))
    }

    @Test func `JSON without n, a non-positive n, and bad JSON are nil`() {
        #expect(MasterRelease.parse(Data(#"{"notes": "x"}"#.utf8), now: now) == nil)
        #expect(MasterRelease.parse(Data(#"{"n": 0}"#.utf8), now: now) == nil)
        #expect(MasterRelease.parse(Data(#"{"n": "273"}"#.utf8), now: now) == nil)
        #expect(MasterRelease.parse(Data("not json".utf8), now: now) == nil)
    }
}

@Suite("DriftLine")
struct DriftLineTests {
    @Test func `behind is master minus running, floored at zero, nil until both are known`() {
        #expect(DriftLine.behind(master: nil, running: 270) == nil)
        #expect(DriftLine.behind(master: 273, running: nil) == nil)
        #expect(DriftLine.behind(master: 273, running: 273) == 0)
        #expect(DriftLine.behind(master: 273, running: 270) == 3)
        #expect(DriftLine.behind(master: 270, running: 273) == 0)
    }

    @Test func `the mark reads +N and is nil when current or unknown`() {
        #expect(DriftLine.mark(behind: 3) == "+3")
        #expect(DriftLine.mark(behind: 0) == nil)
        #expect(DriftLine.mark(behind: nil) == nil)
        #expect(DriftLine.accessibilityLabel(behind: 1) == "1 release behind master")
    }

    @Test(arguments: [
        (build(release: 270), master(273), false, true, true, "3 releases behind master: v1.0.270 → v1.0.273. Deploy from here."),
        (build(release: 272), master(273), false, true, false, "1 release behind master: v1.0.272 → v1.0.273. Deploying needs an admin key."),
        (build(release: 270), master(273), false, false, true, "3 releases behind master: v1.0.270 → v1.0.273. Deploying needs an admin key."),
        (build(release: 270, platform: "darwin"), master(273), false, false, false, "3 releases behind master: v1.0.270 → v1.0.273. Publish from the Mac."),
        (build(release: 273), master(273), false, true, true, "Up to date with master (v1.0.273)."),
        (build(release: 275), master(273), false, true, true, "Up to date with master (v1.0.273)."),
    ])
    func `the footer names the count, both versions and the fix`(build: HelloPush.Build, master: MasterRelease, failed: Bool, canDeploy: Bool, admin: Bool, expected: String) {
        #expect(DriftLine.footer(build: build, master: master, fetchFailed: failed, canDeploy: canDeploy, isAdmin: admin) == expected)
    }

    @Test func `master unknown: silent before the first fetch, a sentence after a failure, nothing without a build`() {
        #expect(DriftLine.footer(build: build(release: 270), master: nil, fetchFailed: false, canDeploy: true, isAdmin: true) == nil)
        #expect(DriftLine.footer(build: build(release: 270), master: nil, fetchFailed: true, canDeploy: true, isAdmin: true) == "Master's version could not be read.")
        #expect(DriftLine.footer(build: nil, master: master(273), fetchFailed: false, canDeploy: true, isAdmin: true) == nil)
    }
}

@Suite("DeployWords")
struct DeployWordsTests {
    @Test func `the confirm's four branches`() {
        #expect(DeployWords.confirm(hostName: "box", deployed: "1.0.270", master: "1.0.273") == "v1.0.270 → v1.0.273, 3 releases. box rebuilds master, trials it and restarts; it rolls back if the trial fails.")
        #expect(DeployWords.confirm(hostName: "box", deployed: "1.0.272", master: "v1.0.273") == "v1.0.272 → v1.0.273, 1 release. box rebuilds master, trials it and restarts; it rolls back if the trial fails.")
        #expect(DeployWords.confirm(hostName: "box", deployed: "1.0.273", master: "1.0.273") == "box already runs v1.0.273. Deploying rebuilds master from GitHub and restarts the service anyway.")
        #expect(DeployWords.confirm(hostName: "box", deployed: "1.0.275", master: "1.0.273") == "v1.0.275 → v1.0.273: master is behind what box runs. Deploying rebuilds master and restarts the service.")
        #expect(DeployWords.confirm(hostName: "box", deployed: "1.0.270", master: nil) == "box runs v1.0.270. Deploying rebuilds master from GitHub, trials it and restarts the service.")
        #expect(DeployWords.confirm(hostName: "box", deployed: nil, master: nil) == "box rebuilds master from GitHub, trials it and restarts the service; it rolls back if the trial fails.")
    }

    @Test func `the row line's five branches`() {
        #expect(DeployWords.rowLine(installed: true, version: "1.0.270", masterVersion: "1.0.273", connected: false, phase: .idle) == "Not connected right now.")
        #expect(DeployWords.rowLine(installed: false, version: "1.0.270", masterVersion: "1.0.273", connected: true, phase: .idle) == "Deploy from the app is not installed on this host.")
        #expect(DeployWords.rowLine(installed: true, version: "1.0.270", masterVersion: "1.0.273", connected: true, phase: .running) == "Runs v1.0.270 · deploying")
        #expect(DeployWords.rowLine(installed: true, version: "1.0.270", masterVersion: nil, connected: true, phase: .idle) == "Runs v1.0.270.")
        #expect(DeployWords.rowLine(installed: true, version: nil, masterVersion: nil, connected: true, phase: .idle) == "Runs an unknown version.")
        #expect(DeployWords.rowLine(installed: true, version: "1.0.273", masterVersion: "1.0.273", connected: true, phase: .done) == "Runs v1.0.273 · up to date with master")
        #expect(DeployWords.rowLine(installed: true, version: "1.0.270", masterVersion: "1.0.273", connected: true, phase: .done) == "Runs v1.0.270 · 3 releases behind master")
        #expect(DeployWords.rowLine(installed: true, version: "1.0.272", masterVersion: "1.0.273", connected: true, phase: .done) == "Runs v1.0.272 · 1 release behind master")
    }
}

@Suite("HostJobCard.deploy")
struct HostJobCardTests {
    @Test func `idle is invisible`() {
        let card = HostJobCard.deploy(status: jobStatus(.idle, target: nil), text: "", hostName: "box", linkUp: true, deployedVersion: nil)
        #expect(card.visible == false)
        #expect(card.lines == [])
    }

    @Test func `pending waits for the trigger`() {
        let card = HostJobCard.deploy(status: jobStatus(.pending), text: "a\nb\n", hostName: "box", linkUp: true, deployedVersion: nil)
        #expect(card.visible)
        #expect(card.title == "Deploying master to box")
        #expect(card.note == "Waiting for the trigger on the box")
        #expect(card.lines == ["a", "b"])
        #expect(card.stoppable == false)
        #expect(card.ending == nil)
    }

    @Test func `running says it cannot be stopped, or that the box is restarting while the link is down`() {
        let up = HostJobCard.deploy(status: jobStatus(.running, target: "v1.0.273"), text: "", hostName: "box", linkUp: true, deployedVersion: nil)
        #expect(up.title == "Deploying v1.0.273 to box")
        #expect(up.note == "Cannot be stopped mid-way; the box rolls back on failure")
        let down = HostJobCard.deploy(status: jobStatus(.running), text: "", hostName: "box", linkUp: false, deployedVersion: nil)
        #expect(down.note == "The box is restarting; the log continues when it is back")
    }

    @Test func `done with exit 0 names the deployed version, else the target`() {
        let named = HostJobCard.deploy(status: jobStatus(.done, exit: 0), text: "", hostName: "box", linkUp: true, deployedVersion: "1.0.273")
        #expect(named.title == "Deployed master to box")
        #expect(named.ending == HostJobCard.Ending(text: "Deployed v1.0.273, the service is back", failed: false))
        let plain = HostJobCard.deploy(status: jobStatus(.done, exit: 0), text: "", hostName: "box", linkUp: true, deployedVersion: nil)
        #expect(plain.ending?.text == "Deployed master, the service is back")
    }

    @Test func `a failure and a run that never started`() {
        let failed = HostJobCard.deploy(status: jobStatus(.done, exit: 1), text: "", hostName: "box", linkUp: true, deployedVersion: nil)
        #expect(failed.title == "Deploy of master to box")
        #expect(failed.ending == HostJobCard.Ending(text: "Deploy failed (exit 1)", failed: true))
        let never = HostJobCard.deploy(status: jobStatus(.done, exit: nil), text: "", hostName: "box", linkUp: true, deployedVersion: nil)
        #expect(never.ending == HostJobCard.Ending(text: "Deploy did not start", failed: true))
    }
}

@Suite("LogTail")
struct LogTailTests {
    @Test func `keeps the last 40 lines and drops a trailing newline`() {
        let text = (1...45).map { "line \($0)" }.joined(separator: "\n") + "\n"
        let tail = LogTail.tail(text)
        #expect(tail.count == 40)
        #expect(tail.first == "line 6")
        #expect(tail.last == "line 45")
        #expect(LogTail.tail("") == [])
        #expect(LogTail.tail("one") == ["one"])
    }

    @Test func `apply: reset drops, append adds, both start over`() {
        #expect(LogTail.apply("a\n", append: "b\n", reset: false) == "a\nb\n")
        #expect(LogTail.apply("a\n", append: nil, reset: true) == "")
        #expect(LogTail.apply("a\n", append: "c\n", reset: true) == "c\n")
        #expect(LogTail.apply("a\n", append: nil, reset: false) == "a\n")
    }

    @Test func `cap keeps the newest lines in memory`() {
        let text = (1...10).map(String.init).joined(separator: "\n")
        #expect(LogTail.cap(text, lines: 3) == "8\n9\n10")
        #expect(LogTail.cap("a\nb", lines: 5) == "a\nb")
    }
}

@Suite("DeviceWords")
struct DeviceWordsTests {
    @Test func `summary: the desktop's three example reports`() {
        let a = report(sims: [simulator("A", state: .booted), simulator("B", state: .shutdown), simulator("C", state: .shutdown)], phones: [phone("iPhone 16 Pro", .connected, transport: "USB")])
        #expect(DeviceWords.summary(a) == "3 simulators, 1 booted · iPhone 16 Pro connected · load 2.1 / 10 cores")
        let b = report(sims: [], phones: [phone("iPhone 17 Pro Max", .paired), phone("iPad", .unavailable)], load: 44.97, cores: 16)
        #expect(DeviceWords.summary(b) == "No simulators · 2 iPhones paired · load 45.0 / 16 cores")
        let c = report(sims: [simulator("A", state: .shutdown)], phones: [phone("iPhone 17 Pro Max", .paired)])
        #expect(DeviceWords.summary(c) == "1 simulator · iPhone 17 Pro Max paired · load 2.1 / 10 cores")
    }

    @Test func `holder and the delete confirm`() {
        let holder = DeviceHolder(sessionId: "s1", title: "Home", status: "running")
        #expect(DeviceWords.holder(holder) == "Home, running")
        #expect(DeviceWords.holder(DeviceHolder(sessionId: "s1", title: "Home")) == "Home")
        let held = DeviceWords.deleteConfirm(simulator("iPhone 17 Pro", state: .booted, holder: holder))
        #expect(held.title == "Delete iPhone 17 Pro?")
        #expect(held.body == "Held by Home, running. Delete anyway?")
        let free = DeviceWords.deleteConfirm(simulator("iPhone 17 Pro", state: .shutdown))
        #expect(free.body == "iPhone 17 Pro (iOS 26.0) and its data are removed from this Mac.")
    }

    @Test func `simulator and phone states`() {
        #expect(DeviceWords.simulatorState(simulator("A", state: .booted, cpu: 33.9)) == DeviceState(tone: .on, text: "iOS 26.0 · Booted · 34% CPU"))
        #expect(DeviceWords.simulatorState(simulator("A", state: .booted)) == DeviceState(tone: .on, text: "iOS 26.0 · Booted"))
        #expect(DeviceWords.simulatorState(simulator("A", state: .shutdown)) == DeviceState(tone: .off, text: "iOS 26.0 · Shutdown"))
        #expect(DeviceWords.simulatorState(simulator("A", state: .other, stateText: "Shutting Down")) == DeviceState(tone: .between, text: "iOS 26.0 · Shutting Down"))
        #expect(DeviceWords.phoneState(phone("iPhone 16 Pro", .connected, transport: "USB")) == DeviceState(tone: .on, text: "iPhone 16 Pro · iOS 26.0 · Connected · USB"))
        #expect(DeviceWords.phoneState(phone("iPhone 16 Pro", .paired)) == DeviceState(tone: .between, text: "iPhone 16 Pro · iOS 26.0 · Paired"))
        #expect(DeviceWords.phoneState(phone("iPad", .unavailable)) == DeviceState(tone: .off, text: "iPad · iOS 26.0 · Unavailable"))
    }

    @Test func `the Xcode line`() {
        let load = HostLoad(oneMinute: 2.1, cores: 10)
        #expect(DeviceWords.xcodeLine(XcodeInfo(path: "/Applications/Xcode-beta.app", name: "Xcode-beta", version: "27.0", from: .newest), load: load) == "Xcode-beta 27.0 · load 2.1 / 10 cores")
        #expect(DeviceWords.xcodeLine(XcodeInfo(path: "/x", name: "Xcode", version: nil, from: .xcodeSelect), load: load) == "Xcode · load 2.1 / 10 cores")
        #expect(DeviceWords.xcodeLine(nil, load: load) == "No Xcode found · load 2.1 / 10 cores")
    }
}

@Suite("MacBridgeWords")
struct MacBridgeWordsTests {
    @Test(arguments: [(1, "1st"), (2, "2nd"), (3, "3rd"), (4, "4th"), (11, "11th"), (12, "12th"), (13, "13th"), (21, "21st"), (22, "22nd"), (23, "23rd"), (101, "101st"), (111, "111th")])
    func ordinal(n: Int, expected: String) {
        #expect(MacBridgeWords.ordinal(n) == expected)
    }

    @Test func `heldLine for load and for the cap; trim`() {
        #expect(MacBridgeWords.heldLine(held(reason: .load, position: 3)) == "Waiting for the Mac · load 12.3 of 8 · 3rd in line")
        #expect(MacBridgeWords.heldLine(held(reason: .cap, position: 2)) == "Waiting for the Mac · 4 of 4 running · 2nd in line")
        #expect(MacBridgeWords.trim(16) == "16")
        #expect(MacBridgeWords.trim(4.5) == "4.5")
    }

    @Test func `commandLine for a run, a read and a write`() {
        #expect(MacBridgeWords.commandLine(call(kind: .run, status: .running, command: "bun test")) == "bun test")
        #expect(MacBridgeWords.commandLine(call(kind: .run, status: .running, argv: ["/bin/echo", "hi"])) == "/bin/echo hi")
        #expect(MacBridgeWords.commandLine(call(kind: .read, status: .paused, path: "/Users/landon/IdeaProjects/temp-code/package.json")) == "temp-code/package.json")
        #expect(MacBridgeWords.commandLine(call(kind: .write, status: .paused, path: "/tmp/out.txt")) == "/tmp/out.txt (write)")
    }

    @Test func `usage, loadLine, loadValue and the pending footer`() {
        let busy = MacBridgeActivityHost(environmentId: "e", name: "box", policy: .full, registered: true, maxRunning: 4, maxThreads: 2, running: 1, held: 2, threads: 1, pending: 0)
        #expect(MacBridgeWords.usage(busy) == "1 running · 2 waiting · 1 thread")
        let idle = MacBridgeActivityHost(environmentId: "e", name: "box", policy: .off, registered: false, maxRunning: 4, maxThreads: 2, running: 0, held: 0, threads: 0, pending: 0)
        #expect(MacBridgeWords.usage(idle) == "Nothing running")
        let load = MacBridgeLoad(load: 12.3, cores: 16, limit: 32, pinned: false, resumeBelow: 24, busy: false, sampledAt: 0)
        #expect(MacBridgeWords.loadLine(load) == "Load 12.3 of 32 · 16 cores")
        #expect(MacBridgeWords.loadValue(load) == "12.3 of 32")
        let hot = MacBridgeLoad(load: 40, cores: 16, limit: 32, pinned: false, resumeBelow: 24, busy: true, sampledAt: 0)
        #expect(MacBridgeWords.loadLine(hot) == "Load 40.0 of 32 · 16 cores, holding new commands until under 24")
        #expect(MacBridgeWords.pendingFooter(pending: 0, macName: "Studio") == nil)
        #expect(MacBridgeWords.pendingFooter(pending: 1, macName: "Studio") == "1 command waits for a decision on Studio; approve it there.")
        #expect(MacBridgeWords.pendingFooter(pending: 2, macName: "Studio") == "2 commands wait for a decision on Studio; approve them there.")
    }

    @Test func `sorted: running, held, paused, oldest first within a status`() {
        let rows = [call(kind: .run, status: .paused, createdAt: 1), call(kind: .run, status: .held, createdAt: 5), call(kind: .run, status: .running, createdAt: 9), call(kind: .run, status: .held, createdAt: 2)]
        #expect(MacBridgeWords.sorted(rows).map { ($0.status, $0.createdAt) }.map { "\($0.0.rawValue)\($0.1)" } == ["running9", "held2", "held5", "paused1"])
    }
}

@Suite("SyncWords")
struct SyncWordsTests {
    @Test func `harnessLine: running, error, never, synced with sets, not connected`() {
        #expect(SyncWords.harnessLine(harness(running: true), now: now) == "Harness config: syncing…")
        #expect(SyncWords.harnessLine(harness(error: "link down"), now: now) == "Harness config: link down")
        #expect(SyncWords.harnessLine(harness(error: "link down", syncedAt: Int(now) - 120_000), now: now) == "Harness config: link down (last synced 2m ago)")
        #expect(SyncWords.harnessLine(harness(), now: now) == "Harness config: never synced")
        #expect(SyncWords.harnessLine(harness(connected: false), now: now) == "Harness config: never synced · not connected")
        #expect(SyncWords.harnessLine(harness(syncedAt: Int(now) - 120_000, files: 143, sets: ["Claude skills": 80, "Codex hooks": 1, "Agents": 0]), now: now) == "Harness config: 143 files (Claude skills 80, Codex hooks 1), synced 2m ago")
        #expect(SyncWords.harnessLine(harness(syncedAt: Int(now) - 10_000, files: 1, connected: false), now: now) == "Harness config: 1 file, synced just now · not connected")
    }

    @Test func `memoryLine: running, error, never, synced with conflicts`() {
        #expect(SyncWords.memoryLine(memory(running: true), now: now) == "Memory: syncing…")
        #expect(SyncWords.memoryLine(memory(error: "refused"), now: now) == "Memory: refused")
        #expect(SyncWords.memoryLine(memory(connected: false), now: now) == "Memory: never synced · not connected")
        #expect(SyncWords.memoryLine(memory(syncedAt: Int(now) - 120_000, files: 61, conflicts: 1), now: now) == "Memory: 61 files, synced 2m ago, 1 conflict")
        #expect(SyncWords.memoryLine(memory(syncedAt: Int(now) - 7_200_000, files: 61, conflicts: 3), now: now) == "Memory: 61 files, synced 2h ago, 3 conflicts")
    }

    @Test func `conflictLine, ago, the conflicts title and the footer`() {
        #expect(SyncWords.conflictLine(MemoryConflict(path: "/x", of: "notes.md", host: "box", at: Int(now) - 7_200_000), now: now) == "box's copy, 2h ago")
        #expect(SyncWords.ago(now - 1_000, now: now) == "just now")
        #expect(SyncWords.ago(now - 180_000, now: now) == "3m ago")
        #expect(SyncWords.conflictsTitle(1) == "1 conflict copy")
        #expect(SyncWords.conflictsTitle(3) == "3 conflict copies")
        #expect(SyncWords.footer(enabled: false, skipped: 0) == "Sync is off on this host.")
        #expect(SyncWords.footer(enabled: true, skipped: 2) == "Skills, commands, hooks and settings go from the Mac to its hosts; memory crosses both ways, the newer copy wins. 2 files stay on this host (over 16 MB, a symlink out of reach, or a macOS binary).")
    }
}

@Suite("HostExtrasAccess and FooterLines")
struct HostExtrasAccessTests {
    @Test func `each control's need and reason`() {
        #expect(HostExtrasAccess.deploy.needs == .admin)
        #expect(HostExtrasAccess.sync.needs == .admin)
        #expect(HostExtrasAccess.deviceActions.needs == .operate)
        #expect(HostExtrasAccess.macStop.needs == .operate)
        #expect(HostExtrasAccess.deploy.reason == "Deploying needs an admin key.")
        #expect(HostExtrasAccess.sync.reason == "Reading the sync state needs an admin key.")
        #expect(HostExtrasAccess.deviceActions.reason == "Shutting down or deleting a simulator needs an operate key.")
        #expect(HostExtrasAccess.macStop.reason == "Stopping a command needs an operate key on the Mac.")
    }

    @Test func `allowed for a read, an operate and an admin key`() {
        let read = environment(caps: [.read])
        let operate = environment(caps: [.read, .operate])
        let admin = environment(caps: [.read, .operate, .approve, .admin])
        #expect(HostExtrasAccess.allCases.map { $0.allowed(read) } == [false, false, false, false])
        #expect(HostExtrasAccess.allCases.map { $0.allowed(operate) } == [false, false, true, true])
        #expect(HostExtrasAccess.allCases.map { $0.allowed(admin) } == [true, true, true, true])
    }

    @Test func `footer lines join two sentences and wrap a third to a second line`() {
        #expect(FooterLines.join([]) == [])
        #expect(FooterLines.join(["A.", nil, ""]) == ["A."])
        #expect(FooterLines.join(["A.", "B."]) == ["A. B."])
        #expect(FooterLines.join(["A.", "B.", "C.", "D."]) == ["A. B.", "C. D."])
    }
}
