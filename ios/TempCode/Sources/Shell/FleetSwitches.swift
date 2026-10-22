import SwiftUI
import TempCodeClient
import TempCodeContract

/// The fleet switches on the phone (docs/box.md "The fleet switches"): Pause
/// all, Resume all, Stop all and Archive done as rows in a host's menu and a
/// project's menu, a confirm sheet whose count stays live while it shows, and
/// one text line at the foot for the outcome. The rules and the words are the
/// client package's `ThreadBatch`; this file is the chrome and the one place
/// the request, the confirm and the run meet, so Home, a host header and a
/// thread's menu share them.

// MARK: - the rows

/// Menu content: the four rows in the desktop's order, each disabled when
/// nothing qualifies, never hidden. A key that cannot act reads the reason
/// as the first line. Where Mark all read exists these rows come after it.
struct FleetSwitchRows: View {
    let client: EnvironmentClient
    let scope: BatchScope
    /// Off inside a menu that already prints the reason as its first line.
    var showsBlock = true

    var body: some View {
        let block = client.operateBlock
        let counts = ThreadBatch.counts(client.sessions, client.batchSelection(scope))
        if let block, showsBlock {
            Text(block.text(now: Date().timeIntervalSince1970 * 1000))
        }
        ForEach(BatchAction.allCases, id: \.self) { action in
            Button(role: action == .stop ? .destructive : nil) {
                FleetSwitches.shared.request(action, client: client, scope: scope)
            } label: {
                Label(ThreadBatch.label(action), systemImage: ThreadBatch.symbol(action))
            }
            .disabled(block != nil || counts[action, default: 0] == 0)
        }
    }
}

// MARK: - the request, the confirm, the run

/// A batch a menu asked for that waits for its confirm.
struct PendingBatch: Identifiable {
    let client: EnvironmentClient
    let action: BatchAction
    let scope: BatchScope

    var id: String { "\(client.environment.id)|\(action.rawValue)|\(scope)" }
}

@MainActor @Observable
final class FleetSwitches {
    static let shared = FleetSwitches()

    /// The confirm the sheet host presents; nil once answered or cancelled.
    var pending: PendingBatch?

    private init() {}

    /// A menu picked an action: resume runs at once, the rest wait for the confirm.
    func request(_ action: BatchAction, client: EnvironmentClient, scope: BatchScope) {
        guard ThreadBatch.needsConfirm(action) else {
            Task { await run(action, client: client, scope: scope) }
            return
        }
        pending = PendingBatch(client: client, action: action, scope: scope)
    }

    func cancel() {
        pending = nil
    }

    /// The confirm's OK, or a resume: the action over what qualifies now, the
    /// answer as the toast. A refusal before the wire (a read key, a link
    /// down) is the toast's line too.
    func run(_ action: BatchAction, client: EnvironmentClient, scope: BatchScope, cleanup: Bool = false) async {
        let toast: BatchToast
        do {
            toast = try await client.batch(action, selection: client.batchSelection(scope), cleanup: cleanup)
        } catch {
            let message = (error as? ActionError)?.message ?? String(describing: error)
            toast = BatchToast(headline: message, succeeded: 0, failed: [])
        }
        FleetToastCenter.shared.post(toast)
    }

    /// The scope of a thread: its project when it has one, else its host.
    static func scope(of meta: SessionMeta, client: EnvironmentClient) -> BatchScope {
        if let project = client.projects.first(where: { $0.id == meta.projectId }) {
            return .project(id: project.id, name: project.name, cwd: project.cwd)
        }
        return .host(name: client.environment.name)
    }

    /// What Home plugs in (HomeSlots.swift): the host menu, the project menu and the restart note, on top of `base`.
    static func homeSlots(_ base: HomeSlots = HomeSlots()) -> HomeSlots {
        var slots = base
        slots.hostMenu = { client in AnyView(FleetSwitchRows(client: client, scope: .host(name: client.environment.name))) }
        slots.projectBatch = { client, project in AnyView(FleetSwitchRows(client: client, scope: .project(id: project.id, name: project.name, cwd: project.cwd))) }
        slots.hostNotes = { client in BootResumeNotes.shared.notes(for: client) }
        return slots
    }
}

/// Presents the pending confirm: one modifier on the root `TabView`, so
/// every menu in the app shares the sheet.
struct FleetSwitchHost: ViewModifier {
    func body(content: Content) -> some View {
        let switches = FleetSwitches.shared
        return content
            .sheet(item: Binding(get: { switches.pending }, set: { if $0 == nil { switches.cancel() } })) { pending in
                FleetConfirmSheet(pending: pending)
            }
    }
}

/// Docks the outcome line above the tab bar: on each tab's root view, inside
/// its navigation stack, so the tab bar and the other tabs never move.
struct FleetToastInset: ViewModifier {
    func body(content: Content) -> some View {
        let center = FleetToastCenter.shared
        return content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let notice = center.notice {
                    FleetToastLine(notice: notice) { center.dismiss() }
                        .transition(.opacity.animation(Motion.crossFade))
                }
            }
            .animation(Motion.crossFade, value: center.notice)
    }
}

extension View {
    /// The fleet switches' confirm sheet, on the root view.
    func fleetSwitchHost() -> some View {
        modifier(FleetSwitchHost())
    }

    /// The fleet switches' outcome line, on a tab's root view.
    func fleetToastInset() -> some View {
        modifier(FleetToastInset())
    }
}

// MARK: - the confirm sheet

/// "Pause 15 running threads on the box?": the count is read from the client
/// while the sheet shows and its digits roll; Archive done offers the
/// resources clause with a switch; the confirm fills the width at the foot.
struct FleetConfirmSheet: View {
    let pending: PendingBatch
    @State private var cleanup = true
    @State private var confirmedAt = 0
    /// The content's height, so the sheet is as tall as what it says.
    @State private var contentHeight: CGFloat = 280
    @Environment(\.dismiss) private var dismiss
    /// The inline navigation bar and the drag indicator above the content.
    @ScaledMetric(relativeTo: .body) private var chrome: CGFloat = 60

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                body(now: context.date)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
        }
        .presentationDetents([.height(contentHeight + chrome)])
        .presentationCornerRadius(Radius.sheet)
        .presentationDragIndicator(.visible)
        .sensoryFeedback(.impact(weight: .light), trigger: confirmedAt)
    }

    private func body(now: Date) -> some View {
        let client = pending.client
        let targets = ThreadBatch.targets(pending.action, client.sessions, client.batchSelection(pending.scope, now: now))
        let queued = targets.count(where: ThreadBatch.isQueued)
        let resources: Int? = pending.action == .archiveDone ? client.resources.countHeld(by: targets.map(\.id)) : nil
        let copy = ThreadBatch.confirm(pending.action, count: targets.count, scope: pending.scope, resources: resources, queued: queued)
        return VStack(alignment: .leading, spacing: 8) {
            Text(copy.title)
                .font(.title3.weight(.semibold))
                .contentTransition(.numericText())
                .animation(Motion.numeric, value: targets.count)
                .fixedSize(horizontal: false, vertical: true)
            Text(copy.body)
                .textStep(.meta)
                .fixedSize(horizontal: false, vertical: true)
            if let clause = copy.cleanup {
                Toggle(isOn: $cleanup) {
                    Text(clause)
                        .textStep(.meta)
                }
                .padding(12)
                .groupCard()
                .padding(.top, 8)
            }
            Button {
                confirmedAt += 1
                let cleanup = copy.cleanup != nil && cleanup
                dismiss()
                Task { await FleetSwitches.shared.run(pending.action, client: client, scope: pending.scope, cleanup: cleanup) }
            } label: {
                Text(copy.confirmLabel)
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: Layout.rowHeight)
                    .foregroundStyle(Color(.systemBackground))
                    .background(copy.danger ? Tint.destructive : Color(.label), in: RoundedRectangle.fieldCorner)
            }
            .buttonStyle(.pressable)
            .disabled(targets.isEmpty)
            .opacity(targets.isEmpty ? 0.5 : 1)
            .padding(.top, 16)
        }
        .padding(Layout.textEdge)
        .frame(maxWidth: .infinity, alignment: .top)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
    }
}

// MARK: - the toast

/// What the line at the foot shows: a batch's outcome, or one message (a
/// single action that failed).
enum FleetNotice: Hashable {
    case batch(BatchToast)
    case message(String)

    var summary: String {
        switch self {
        case .batch(let toast): toast.summary
        case .message(let text): text
        }
    }

    /// Waits for a tap: a failure must be read.
    var sticky: Bool {
        switch self {
        case .batch(let toast): !toast.failed.isEmpty
        case .message: true
        }
    }
}

/// The one outcome line at the foot. A clean result leaves after four
/// seconds; one with a failure waits for a tap.
@MainActor @Observable
final class FleetToastCenter {
    static let shared = FleetToastCenter()

    private(set) var notice: FleetNotice?
    private var leave: Task<Void, Never>?

    private init() {}

    static let lingerSeconds: Double = 4

    func post(_ toast: BatchToast) {
        show(.batch(toast))
    }

    /// One action's failure, in the same line.
    func post(message: String) {
        show(.message(message))
    }

    private func show(_ next: FleetNotice) {
        leave?.cancel()
        notice = next
        AccessibilityNotification.Announcement(next.summary).post()
        guard !next.sticky else { return }
        leave = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.lingerSeconds))
            guard !Task.isCancelled, self?.notice == next else { return }
            self?.notice = nil
        }
    }

    func dismiss() {
        leave?.cancel()
        notice = nil
    }
}

/// The fleet switches' outcome, floating above the tab bar on a glass card:
/// the count in semibold ("Paused 14"), and under it, when anything failed,
/// "1 failed: Search (harness not responding)" in the destructive tint. A
/// whole-call failure is the one line in the destructive tint. Tap to dismiss.
struct FleetToastLine: View {
    let notice: FleetNotice
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            switch notice {
            case .message(let message):
                Text(message)
                    .foregroundStyle(Tint.destructive)
            case .batch(let toast):
                Text(toast.headline)
                    .fontWeight(.semibold)
                if let failure = toast.failureLine {
                    Text(failure)
                        .foregroundStyle(Tint.destructive)
                        .lineLimit(2)
                }
            }
        }
        .font(.footnote)
        .multilineTextAlignment(.leading)
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .tcGlass(in: RoundedRectangle.sheetCorner)
        .padding(.horizontal, ComposerBar.edge)
        .padding(.bottom, 6)
        .contentShape(Rectangle())
        .onTapGesture { dismiss() }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(notice.summary)
        .accessibilityHint("Dismiss")
    }
}

// MARK: - the restart note

/// "7 threads resumed after restart": the client's `bootResume` is already
/// once per boot (the boot's time kept in the cache); the line shows for
/// fifteen seconds whenever a new one lands.
@MainActor @Observable
final class BootResumeNotes {
    static let shared = BootResumeNotes()

    private(set) var shown: [String: BootResumeNotice] = [:]
    private var leaves: [String: Task<Void, Never>] = [:]
    private var noted: [String: Int] = [:]

    private init() {}

    static let lingerSeconds: Double = 15

    /// Every client's notice, read whenever one changes.
    func observe(_ clients: [EnvironmentClient]) {
        for client in clients {
            guard let notice = client.bootResume else { continue }
            note(environmentId: client.environment.id, notice: notice)
        }
    }

    func note(environmentId: String, notice: BootResumeNotice) {
        guard notice.count > 0, noted[environmentId] != notice.at else { return }
        noted[environmentId] = notice.at
        shown[environmentId] = notice
        leaves[environmentId]?.cancel()
        leaves[environmentId] = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.lingerSeconds))
            guard !Task.isCancelled else { return }
            self?.shown[environmentId] = nil
        }
    }

    /// The line for a host, when one shows.
    func line(for client: EnvironmentClient) -> String? {
        shown[client.environment.id].map { StatusWords.bootResume(count: $0.count) }
    }

    /// Home's `hostNotes` slot: the one line, or nothing.
    func notes(for client: EnvironmentClient) -> [HomeNote] {
        line(for: client).map { [HomeNote(id: "boot-resume:\(client.environment.id)", text: $0)] } ?? []
    }
}

// MARK: - one root's state rows

/// Menu content for one root: Start now on a queued thread (`session.start`,
/// past its `after`), Resume on a stopped one (`session.resume` boots a
/// fresh harness). Nothing for any other status. A failure goes to
/// `onFailure` when the menu has an alert, else to the line at the foot.
struct RowStateActions: View {
    let client: EnvironmentClient
    let meta: SessionMeta
    var onFailure: ((String) -> Void)?

    var body: some View {
        let block = client.operateBlock
        if meta.status == .queued {
            Button {
                act { try await client.start(meta.id) }
            } label: {
                Label("Start now", systemImage: "play")
            }
            .disabled(block != nil)
        }
        if meta.status == .stopped {
            Button {
                act { try await client.resume(meta.id) }
            } label: {
                Label("Resume", systemImage: "arrow.clockwise")
            }
            .disabled(block != nil)
        }
    }

    private func act(_ body: @escaping () async throws -> Void) {
        let onFailure = onFailure
        Task {
            do {
                try await body()
            } catch {
                let message = (error as? ActionError)?.message ?? String(describing: error)
                if let onFailure { onFailure(message) } else { FleetToastCenter.shared.post(message: message) }
            }
        }
    }
}

// MARK: - archive with resources

/// The one way to archive a thread: at once when it holds nothing, else the
/// prompt that offers to remove what it made. Both archive sites call this.
enum ArchivePrompt {
    static func archive(_ client: EnvironmentClient, _ meta: SessionMeta, present: (ArchiveWithResourcesSheet.Target) -> Void) async throws {
        if client.resources.live(for: meta.id).isEmpty {
            try await client.archive(meta.id, removeResources: false)
        } else {
            present(ArchiveWithResourcesSheet.Target(client: client, meta: meta))
        }
    }
}
