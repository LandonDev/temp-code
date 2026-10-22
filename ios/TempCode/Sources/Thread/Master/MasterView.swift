import SwiftUI
import TempCodeClient
import TempCodeContract

/// A master's Board segment (docs/IOS-DESIGN.md "Master: the batch is the
/// hero"): the bar with + Thread and the batch's ⋯, then one plain list of
/// the batch's roots in four groups (Needs you, Running, Queued, Done) and,
/// as the list's last section, the foot: the summary, the rules as one
/// sentence with Edit, the blocked line and the steps with the running one's
/// console. A tap on a row pushes the child's own thread screen. The state is
/// the client's `batch(_:)`, loaded on appear, on every socket open and every
/// 5 s while the board shows; the push keeps it current between. Nothing
/// animates on the first paint.
struct MasterView: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState
    @Environment(AppModel.self) private var app
    /// The person's own fold of each row's task list, by row key.
    @State private var tasksOpen: [String: Bool] = [:]
    /// Failed steps whose console the person hid.
    @State private var foldedSteps: Set<String> = []
    @State private var sheet: MasterSheet?
    @State private var pausing = false
    @State private var failure: String?
    /// The DEBUG open ran.
    @State private var opened = false

    var body: some View {
        let state = client.batchState(sessionId) ?? .empty(masterId: sessionId)
        let hostNames = Dictionary(app.registry.ordered.map { ($0.environment.id, $0.environment.name) }, uniquingKeysWith: { first, _ in first })
        let paired = farMetas(state)
        let remote = MasterBoard.remoteChildren(state, localHost: client.environment.id) { env, id in paired["\(env):\(id)"] }
        let rows = MasterBoard.foldRows(children: MasterBoard.children(of: sessionId, in: client.sessions), all: client.sessions, masterId: sessionId, remote: remote)
        let sections = MasterBoard.sections(rows)
        let landed = Set(state.landed)
        let steps = BatchSteps.liveSteps(state)
        let titleOf = { (id: String) -> String? in
            rows.first { $0.sessionId == id || $0.batchKey == id }?.title
                ?? state.children?.first { $0.sessionId == id || "\($0.environmentId):\($0.sessionId)" == id }?.title
        }
        VStack(spacing: 0) {
            MasterBar(
                block: client.operateBlock,
                rows: rows,
                candidates: session.map { BoardActions.adoptCandidates(client.sessions, master: $0) } ?? [],
                onAdd: { sheet = .add },
                onAdopt: { sheet = .adopt },
                onPause: { pausing = true },
                onResume: { switchRows(.resume, BoardActions.pausedRows(rows)) },
                onArchive: { sheet = .archive($0) }
            )
            Hairline()
            List {
                if rows.isEmpty {
                    Text("No threads yet")
                        .textStep(.meta)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 40)
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                ForEach(sections) { section in
                    Section {
                        ForEach(section.rows) { row in
                            MasterRowView(
                                row: row,
                                client: clientFor(row),
                                landed: landed.contains(row.batchKey),
                                hostName: row.environmentId.flatMap { hostNames[$0] },
                                tasksOpen: $tasksOpen,
                                fleetSize: rows.count
                            )
                            .listRowInsets(EdgeInsets())
                            .listRowSeparator(.visible)
                            .alignmentGuide(.listRowSeparatorLeading) { [inset = MasterLayout.bodyInset] _ in inset }
                            .listRowBackground(row.status == .waiting ? Surface.needsYou : Color.clear)
                        }
                    } header: {
                        SectionHeader(section.id.label) { CountText(section.rows.count) }
                            .listRowInsets(EdgeInsets())
                    }
                }
                Section {
                    BatchFoot(
                        state: state,
                        steps: steps,
                        folded: $foldedSteps,
                        titleOf: titleOf,
                        hostName: { hostNames[$0] },
                        block: client.operateBlock,
                        onStop: stop
                    )
                } header: {
                    SectionHeader("When the threads are done") {
                        Button("Edit") { sheet = .rules }
                            .font(.footnote)
                            .buttonStyle(.pressableStatic)
                            .frame(minHeight: 30)
                            .accessibilityIdentifier("batch-edit")
                    }
                    .listRowInsets(EdgeInsets())
                }
            }
            .listStyle(.plain)
            .listSectionSpacing(0)
            .environment(\.defaultMinListRowHeight, Layout.rowHeight)
            .scrollContentBackground(.hidden)
        }
        .background(Surface.background)
        .task(id: client.status.transport == .open) { await client.loadBatch(sessionId) }
        .task {
            // The desktop's floor under the push while the board shows.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                if Task.isCancelled { return }
                await client.loadBatch(sessionId)
            }
        }
        .sheet(item: $sheet) { which in
            sheetView(which, state: state, rows: rows)
        }
        .confirmationDialog(pauseCopy(rows).title, isPresented: $pausing, titleVisibility: .visible) {
            Button(pauseCopy(rows).confirmLabel) { switchRows(.pause, BoardActions.pausableRows(rows)) }
        } message: {
            Text(pauseCopy(rows).body)
        }
        .alert("Couldn't do that", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failure ?? "")
        }
        .onChange(of: client.batchState(sessionId) != nil, initial: true) {
            // DEBUG proof: open one sheet once the batch has landed.
            guard !opened, client.batchState(sessionId) != nil, let open = TestHooks.open else { return }
            opened = true
            switch open {
            case "rules": sheet = .rules
            case "add-thread": sheet = .add
            case "adopt": sheet = .adopt
            case "archive-done": sheet = .archive(.done)
            default: break
            }
        }
    }

    @ViewBuilder
    private func sheetView(_ which: MasterSheet, state: BatchState, rows: [MasterBoard.Row]) -> some View {
        if let session {
            switch which {
            case .rules:
                RulesSheet(client: client, master: session, rules: state.rules)
            case .add:
                AddThreadSheet(client: client, master: session, rows: rows)
            case .adopt:
                AdoptThreadSheet(client: client, master: session)
            case .archive(let which):
                ArchiveBatchSheet(client: client, master: session, which: which, count: which == .done ? BoardActions.doneRows(rows).count : rows.count)
            }
        }
    }

    /// The far children's metas from their own hosts' clients, keyed `<env>:<id>`, read on the main actor.
    private func farMetas(_ state: BatchState) -> [String: SessionMeta] {
        var out: [String: SessionMeta] = [:]
        for far in state.children ?? [] where far.environmentId != client.environment.id {
            if let meta = app.registry.client(far.environmentId)?.session(far.sessionId) { out["\(far.environmentId):\(far.sessionId)"] = meta }
        }
        return out
    }

    private func pauseCopy(_ rows: [MasterBoard.Row]) -> BoardActions.ConfirmCopy {
        BoardActions.pauseCopy(count: BoardActions.pausableRows(rows).count)
    }

    /// The row's own host's client: this one for a local row, the paired host's for a remote one, else nil.
    private func clientFor(_ row: MasterBoard.Row) -> EnvironmentClient? {
        guard let env = row.environmentId else { return client }
        return app.registry.client(env)
    }

    /// Pause all or Resume all: `session.batch` over the qualifying local
    /// rows, never the master's own pause (that would pause its turn too).
    private func switchRows(_ action: Methods.SessionBatch.Params.Action, _ rows: [MasterBoard.Row]) {
        let ids = BoardActions.localIds(rows)
        guard !ids.isEmpty else { return }
        Task {
            do {
                let result = try await client.sessionBatch(action, ids: ids)
                if let first = result.failed.first {
                    let title = rows.first { $0.sessionId == first.sessionId }?.title ?? "a thread"
                    failure = "\(result.failed.count) failed: \(title) (\(first.error))"
                }
            } catch {
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }

    private func stop(_ stepId: String) {
        Task {
            do {
                try await client.stopBatchStep(sessionId, stepId: stepId)
            } catch {
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }
}

/// The board's sheets.
enum MasterSheet: Identifiable, Hashable {
    case rules
    case add
    case adopt
    case archive(BoardActions.Which)

    var id: String {
        switch self {
        case .rules: "rules"
        case .add: "add"
        case .adopt: "adopt"
        case .archive(let which): "archive-\(which.rawValue)"
        }
    }
}

/// The 44 pt bar under the segment control: + Thread (New thread…, Add
/// existing thread…) on the left, the batch's ⋯ (Pause all, Resume all,
/// Archive done…, Archive all…) on the right. The thread's own ⋯ stays in
/// the navigation bar. A row with nothing to act on is disabled, never
/// hidden; a key that cannot operate sees the reason as each menu's last line.
private struct MasterBar: View {
    let block: ActionBlock?
    let rows: [MasterBoard.Row]
    let candidates: [SessionMeta]
    let onAdd: () -> Void
    let onAdopt: () -> Void
    let onPause: () -> Void
    let onResume: () -> Void
    let onArchive: (BoardActions.Which) -> Void

    var body: some View {
        let now = Date().timeIntervalSince1970 * 1000
        let pausable = BoardActions.pausableRows(rows)
        let paused = BoardActions.pausedRows(rows)
        let done = BoardActions.doneRows(rows)
        HStack(spacing: 8) {
            Menu {
                Button(action: onAdd) { Label("New thread…", systemImage: "plus.bubble") }
                    .disabled(block != nil)
                Button(action: onAdopt) { Label("Add existing thread…", systemImage: "tray.and.arrow.down") }
                    .disabled(block != nil || candidates.isEmpty)
                if let block { Text(block.text(now: now)) }
            } label: {
                PillLabel(title: "Thread", systemImage: "plus")
            }
            .buttonStyle(.pressable)
            .accessibilityLabel("Add a thread")
            .accessibilityIdentifier("master-add")
            Spacer(minLength: 8)
            Menu {
                Button(action: onPause) { Label("Pause all", systemImage: "pause") }
                    .disabled(pausable.isEmpty || block != nil)
                Button(action: onResume) { Label("Resume all", systemImage: "play") }
                    .disabled(paused.isEmpty || block != nil)
                Divider()
                Button { onArchive(.done) } label: { Label("Archive done…", systemImage: "archivebox") }
                    .disabled(done.isEmpty || block != nil)
                Button { onArchive(.all) } label: { Label("Archive all…", systemImage: "archivebox") }
                    .disabled(rows.isEmpty || block != nil)
                if let block { Text(block.text(now: now)) }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.body)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .buttonStyle(.pressableStatic)
            .accessibilityLabel("Batch actions")
            .accessibilityIdentifier("master-menu")
        }
        .padding(.horizontal, Layout.textEdge)
        .frame(height: MasterLayout.barHeight)
        .background(Surface.chrome)
    }
}
