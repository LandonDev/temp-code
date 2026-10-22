import SwiftUI
import TempCodeClient
import TempCodeContract

/// `+3`: how many releases a host runs behind master, muted and tabular,
/// for the Hosts row and Home's status row. Nothing when the host is current
/// or either number is unknown. No motion: it changes a few times a day.
/// It keeps master's release fresh while it is on screen; the zero-size
/// stack holds the task when there is no mark to draw.
struct DriftMark: View {
    let client: EnvironmentClient

    var body: some View {
        let behind = DriftLine.behind(master: MasterReleaseWatcher.shared.release?.release, running: client.status.lastHello?.build?.release)
        ZStack {
            if let behind, let mark = DriftLine.mark(behind: behind) {
                Text(mark)
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .fixedSize()
                    .accessibilityLabel(DriftLine.accessibilityLabel(behind: behind))
            }
        }
        .task { await MasterReleaseWatcher.shared.run() }
    }
}

/// Build: master's version, and for a box the deploy that brings it up.
/// The host's own version stays in the Host section; the footer names the
/// gap and the fix (or why it is out of reach) in at most two lines.
struct HostBuildSection: View {
    let client: EnvironmentClient
    /// The section's loops (HostActivitySections' `ActivityPollers`), held
    /// behind the one row that is always here so they never restart.
    let pollers: AnyView
    @State private var confirming = false
    @State private var showLog = false
    @State private var actionError: String?

    var body: some View {
        let extras = client.extras
        let watcher = MasterReleaseWatcher.shared
        let build = client.status.lastHello?.build
        let isMac = build?.platform == "darwin"
        let admin = HostExtrasAccess.deploy.allowed(client.environment)
        let open = client.status.transport == .open
        let job = extras.deployJob
        let phase = job?.phase ?? .idle
        let installed = extras.deploy?.installed == true
        let canDeploy = !isMac && open && admin && installed && (phase == .idle || phase == .done)
        Section {
            LabeledContent("Master") {
                Text(watcher.release.map { "v\($0.version)" } ?? "—")
                    .monospacedDigit()
            }
            .background { pollers }
            .alert("Deploy master to \(client.environment.name)?", isPresented: $confirming) {
                Button("Cancel", role: .cancel) {}
                Button("Deploy") { deploy() }
            } message: {
                Text(DeployWords.confirm(hostName: client.environment.name, deployed: build?.version, master: watcher.release?.version))
            }
            .sheet(isPresented: $showLog) { DeployLogSheet(client: client) }
            .onAppear {
                #if DEBUG
                if TestHooks.sheet == "deploy-log" { showLog = true }
                #endif
            }
            if !isMac {
                Button("Deploy Master") { confirming = true }
                    .disabled(!canDeploy)
                    .accessibilityIdentifier("deploy-master")
                if let job, job.phase != .idle {
                    DeployJobRow(card: HostJobCard.deploy(status: job, text: extras.log.text, hostName: client.environment.name, linkUp: open, deployedVersion: build?.version)) {
                        showLog = true
                    }
                }
                RowErrorLine(message: $actionError)
            }
        } header: {
            Text("Build")
        } footer: {
            FooterText(lines: footer(build: build, isMac: isMac, admin: admin, open: open, installed: installed, canDeploy: canDeploy))
        }
    }

    private func footer(build: HelloPush.Build?, isMac: Bool, admin: Bool, open: Bool, installed: Bool, canDeploy: Bool) -> [String] {
        let watcher = MasterReleaseWatcher.shared
        let drift = DriftLine.footer(build: build, master: watcher.release, fetchFailed: watcher.fetchFailed, canDeploy: canDeploy, isAdmin: admin)
        var lines: [String?] = [drift]
        if !isMac {
            if !open {
                lines.append(DeployWords.rowLine(installed: installed, version: nil, masterVersion: nil, connected: false, phase: .idle))
            } else if !admin {
                // The drift sentence already says it when the box is behind.
                if drift?.contains(HostExtrasAccess.deploy.reason) != true { lines.append(HostExtrasAccess.deploy.reason) }
            } else if client.extras.deploy?.installed == false {
                lines.append(DeployWords.rowLine(installed: false, version: nil, masterVersion: nil, connected: true, phase: .idle))
            }
        }
        return FooterLines.join(lines)
    }

    private func deploy() {
        let extras = client.extras
        showLog = true
        Task {
            do {
                try await extras.startDeploy()
            } catch {
                showLog = false
                withAnimation(Motion.rowAppear) { actionError = (error as? ActionError)?.message ?? error.localizedDescription }
            }
        }
    }
}

/// The running or finished deploy: the mark column (spinner, check, cross),
/// the card's title swapping in place, its note or ending under it, and a
/// chevron; a tap opens the log.
struct DeployJobRow: View {
    let card: HostJobCard
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: Layout.rowGap) {
                MarkColumn(key: markKey) { mark }
                VStack(alignment: .leading, spacing: 2) {
                    SwapText(card.title, step: .title)
                    if let ending = card.ending {
                        Text(ending.text)
                            .textStep(.meta, tint: ending.failed ? Tint.destructive : nil)
                            .lineLimit(2)
                    } else if let note = card.note {
                        Text(note)
                            .textStep(.meta)
                            .lineLimit(2)
                    }
                }
                Spacer(minLength: Layout.rowGap)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .tint(.primary)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Shows the deploy log")
    }

    private var markKey: String {
        if let ending = card.ending { return ending.failed ? "failed" : "passed" }
        return "running"
    }

    @ViewBuilder private var mark: some View {
        if let ending = card.ending {
            // Regular weight: the title beside it is regular too.
            Image(systemName: ending.failed ? "xmark" : "checkmark")
                .font(.footnote)
                .foregroundStyle(ending.failed ? Tint.destructive : Tint.success)
        } else {
            ProgressView().controlSize(.mini)
        }
    }
}
