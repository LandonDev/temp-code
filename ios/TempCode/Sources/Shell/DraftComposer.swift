import PhotosUI
import SwiftUI
import TempCodeClient
import TempCodeContract

/// A project's one remembered draft at the foot of its shell, the desktop's
/// new-chat screen: the composer's box (`ComposerBox`), the row under it
/// (`ComposerRowView`: the model and its effort, the permission mode), and
/// 4 pt under that the draft row: the type (its tinted glyph and its name, a
/// menu of the types with their one-line hints), the thread's name ("Name
/// this thread", 80 characters, the title the first send gives it), the host for a project
/// linked across hosts (every copy, then "New copy on <host>" through
/// `project.ensureLinked`), and for a chat "Master thread", which needs an
/// admin key (a lesser key reads the reason in its place). Everything is
/// kept in `ProjectDraftStore` as it changes (written after 500 ms of
/// quiet), photos in memory only. Nothing reaches the host until the first
/// send (`sendDraft`), which waits for the host's catalog (asked again when
/// a host that was down comes up, the row saying "Waiting for <host>"
/// meanwhile) and carries the model and effort the picker shows; while the create
/// runs the button spins and the strip draws the thread's chip
/// (`DraftSending`); the box empties at the click and stays open, so what
/// is written meanwhile is the next draft, and a failed create gives the
/// sent text and photos back. The send opens the new thread in the shell.
struct DraftComposer: View {
    let scope: StripScope
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @FocusState private var focused: Bool
    @State private var draft = ProjectDraft()
    @State private var choice = CatalogChoice(provider: .claude, model: "", reasoning: nil)
    @State private var busy = false
    @State private var failure: String?
    @State private var picking = false
    @State private var picked: [PhotosPickerItem] = []
    @State private var sentCount = 0
    private let store = ProjectDraftStore.shared
    #if DEBUG
    /// The launch action ran (a shell rebuilt by the send must not run it again).
    @MainActor static var launchActed = false
    #endif

    static let types: [ThreadType] = [.chat, .planning, .projectPlan, .implementation, .orchestration, .research]

    private var key: String { scope.key }

    /// One copy of the scope: the host it lives on, its workspace and its project (none for loose chats).
    struct Copy: Identifiable {
        let client: EnvironmentClient
        let workspace: WorkspaceMeta
        let project: ProjectMeta?
        var id: String { client.environment.id }
    }

    /// Every copy the scope has on a host the app knows, the lead's first.
    private var copies: [Copy] {
        switch scope.kind {
        case .project(let project):
            return project.members.compactMap { member in
                guard let client = model.registry.client(member.environmentId),
                      let workspace = client.workspaces.first(where: { $0.id == member.group.project.workspaceId }) else { return nil }
                return Copy(client: client, workspace: workspace, project: member.group.project)
            }
        case .workspaceChats(let workspace):
            return workspace.members.compactMap { member in
                model.registry.client(member.environmentId).map { Copy(client: $0, workspace: member.workspace, project: nil) }
            }
        }
    }

    /// The copy the first send starts on: the draft's host when it has a copy there, else the lead.
    private var target: Copy? {
        let copies = copies
        return copies.first { $0.id == draft.environmentId } ?? copies.first
    }

    /// Connected hosts with no copy of a linked project yet: "New copy" makes one there.
    private var newCopyHosts: [EnvironmentClient] {
        guard case .project = scope.kind, let lead = copies.first?.project, lead.linkId != nil else { return [] }
        let held = Set(copies.map(\.id))
        return model.registry.ordered.filter { !held.contains($0.environment.id) && $0.status.transport == .open }
    }

    private var block: String? {
        target?.client.operateBlock.map { $0.text(now: Date().timeIntervalSince1970 * 1000) }
    }

    /// The host's catalog has landed (the model is known) and nothing is in flight.
    private var canSend: Bool {
        DraftSend.canSend(text: draft.text, sending: busy, model: choice.catalog == nil ? "" : choice.key.model)
    }

    private var photos: [DraftPhoto] { store.photos[key] ?? [] }

    /// The draft's text as the field writes it, kept as it changes; a paste of more than one line eases the height.
    private var field: Binding<String> {
        Binding {
            draft.text
        } set: { new in
            if ComposerHeight.eases(from: draft.text, to: new), !reduceMotion {
                withAnimation(Motion.base) { draft.text = new }
            } else {
                Motion.withoutAnimation { draft.text = new }
            }
            failure = nil
            store.set(key, draft)
        }
    }

    /// The draft row's name, cut at 80 characters as it is typed.
    private var title: Binding<String> {
        Binding {
            draft.title ?? ""
        } set: { new in
            draft.title = ProjectDraft.cleanTitle(new)
            store.set(key, draft)
        }
    }

    private var mode: Binding<PermissionPolicy> {
        Binding {
            draft.permission ?? .edits
        } set: { policy in
            draft.permission = policy
            store.set(key, draft)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let failure {
                QuietLine(symbol: "exclamationmark.circle", text: failure, tint: Tint.destructive)
                    .transition(.opacity)
            }
            if !photos.isEmpty {
                DraftPhotoStrip(photos: photos) { store.removePhoto(key, at: $0) }
                    .transition(Motion.appear(reduced: reduceMotion))
            }
            VStack(spacing: ComposerMetrics.rowGap) {
                TCGlassContainer {
                    ComposerBox(placeholder: ComposerRules.placeholder(for: nil), text: field, focused: $focused, blocked: block, canAttach: block == nil, attachEnabled: photos.count < ComposerBar.maxPhotos, onAttach: { picking = true }) {
                        ComposerButton(intent: .send, enabled: canSend, offersQueue: false, holding: .constant(false), reduced: reduceMotion, busy: busy, onTap: send, onQueue: {})
                    }
                }
                if let client = target?.client {
                    ComposerRowView(client: client, session: nil, choice: choice, draftMode: mode, waiting: CatalogLoad.waitLine(hostName: client.environment.name, transport: client.status.transport, hasCatalog: choice.catalog != nil))
                    DraftRow(draft: draft, title: title, types: Self.types, copies: copies, newCopyHosts: newCopyHosts, masterBlock: ProjectDrafts.masterBlock(caps: client.environment.caps), setType: setType, setMaster: setMaster, setHost: setHost, newCopy: newCopy, titleDone: { focused = true })
                }
            }
        }
        .padding(.horizontal, ComposerBar.edge)
        .padding(.vertical, 6)
        .background(alignment: .top) { BottomEdgeFade() }
        .animation(Motion.crossFade, value: failure)
        .animation(reduceMotion ? nil : Motion.collapse, value: photos.isEmpty)
        .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
        .photosPicker(isPresented: $picking, selection: $picked, maxSelectionCount: max(1, ComposerBar.maxPhotos - photos.count), matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task { await add(items) }
        }
        .onChange(of: key, initial: true) { draft = store.draft(key) ?? ProjectDraft() }
        // The drafts wait 500 ms of quiet before they are written; leaving writes them now.
        .onChange(of: scenePhase) { if scenePhase != .active { store.flush() } }
        .onDisappear { store.flush() }
        .onChange(of: store.focusRequest, initial: true) {
            guard store.focusRequest == key else { return }
            draft = store.draft(key) ?? draft
            focused = true
            store.focusRequest = nil
        }
        // The model and effort follow the catalog of the host the draft starts on; a pick is kept with the draft.
        // A host whose link was down answered nothing: its coming up runs this again.
        .task(id: target.map { CatalogChoice.trigger($0.client) }) {
            guard let client = target?.client else { return }
            if let provider = draft.provider, let model = draft.model {
                choice = CatalogChoice(provider: provider, model: model, reasoning: draft.reasoning)
            }
            await choice.load(client)
        }
        .onChange(of: choice.key) { keepChoice() }
        .onChange(of: choice.reasoning) { keepChoice() }
        #if DEBUG
        .task {
            // The proof's `draft:` on a shell with no thread open: the text lands as if typed; nothing sends.
            // `new-chat`: the chat draft New thread focused types its message and sends it, once.
            guard !Self.launchActed, let action = TestHooks.action else { return }
            if action.hasPrefix("draft:") {
                Self.launchActed = true
                draft.text = String(action.dropFirst(6))
                store.set(key, draft)
                focused = true
            } else if action == "new-chat" {
                Self.launchActed = true
                draft.text = "A chat started from its draft"
                store.set(key, draft)
                for _ in 0..<50 where choice.catalog == nil { try? await Task.sleep(for: .milliseconds(100)) }
                send()
            } else if action == "new-chat-wait" {
                // A draft opened while its host is down (the test server's `/hold`): the row
                // says "Waiting for <host>", and the send goes once the host is up and its catalog lands.
                Self.launchActed = true
                draft.text = "A chat sent once its host came up"
                store.set(key, draft)
                for _ in 0..<TestHooks.catalogWaitTicks where choice.catalog == nil { try? await Task.sleep(for: .milliseconds(100)) }
                send()
            } else if action == "new-chat-held" {
                // The send in flight for the shot: a named chat whose create the hook holds (`send`).
                Self.launchActed = true
                draft.text = "A chat held while its create runs"
                draft.title = "Held mid-send"
                store.set(key, draft)
                for _ in 0..<50 where choice.catalog == nil { try? await Task.sleep(for: .milliseconds(100)) }
                send()
            }
        }
        #endif
    }

    private func keepChoice() {
        guard choice.picked else { return }
        draft.provider = choice.key.provider
        draft.model = choice.key.model
        draft.reasoning = choice.reasoning
        store.set(key, draft)
    }

    private func setType(_ type: ThreadType) {
        draft.threadType = type
        if type != .chat { draft.master = false }
        store.set(key, draft)
    }

    private func setMaster(_ on: Bool) {
        draft.master = on
        store.set(key, draft)
    }

    private func setHost(_ environmentId: String) {
        draft.environmentId = environmentId
        store.set(key, draft)
    }

    /// A copy of the linked project on `client`'s host, found or made; the draft then starts there.
    private func newCopy(_ client: EnvironmentClient) {
        guard let lead = copies.first, let project = lead.project, let params = ProjectDrafts.ensureLinkedParams(project: project, workspace: lead.workspace) else { return }
        Task {
            do {
                let result = try await client.ensureLinked(params)
                if result.project != nil {
                    setHost(client.environment.id)
                } else {
                    failure = result.note ?? "No checkout of this project on \(client.environment.name)"
                }
            } catch {
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }

    private func add(_ items: [PhotosPickerItem]) async {
        for item in items.prefix(ComposerBar.maxPhotos - photos.count) {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let type = item.supportedContentTypes.first
            let number = photos.count + 1
            store.addPhoto(key, DraftPhoto(name: "photo-\(number).\(type?.preferredFilenameExtension ?? "jpeg")", mime: type?.preferredMIMEType, data: data))
        }
    }

    /// The first send: the thread made on the draft's copy and opened in the
    /// shell. The box empties at the click, as the desktop's composer does:
    /// what was sent (its text, name and photos) rides the strip's chip while
    /// the create runs, and what is written meanwhile is the next draft. Only
    /// a failed create gives the sent words and photos back.
    private func send() {
        guard canSend, let target else { return }
        busy = true
        sentCount += 1
        let key = key
        let (sent, sentPhotos) = store.take(key)
        let text = sent.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // A keyboard action never animates: the field empties at once.
        Motion.withoutAnimation { draft = store.draft(key) ?? sent.taken }
        let client = target.client
        let thread = ProjectDrafts.threadDraft(sent, workspaceId: target.workspace.id, projectId: target.project?.id, provider: choice.key.provider, model: choice.key.model, reasoning: choice.reasoning)
        store.beginSending(key, DraftSending(environmentId: client.environment.id, workspaceId: target.workspace.id, projectId: target.project?.id, title: DraftSending.title(of: sent, text: text), threadType: sent.threadType, provider: thread.provider, model: thread.model, startedAt: Int(Date().timeIntervalSince1970 * 1_000)))
        Task {
            defer { busy = false }
            do {
                #if DEBUG
                // The proof's held send: the spinner and the chip stay up long enough to be shot.
                if TestHooks.action == "new-chat-held" { try? await Task.sleep(for: .seconds(TestHooks.draftHoldSeconds)) }
                #endif
                let meta = try await client.sendDraft(thread, text: text, photos: sentPhotos)
                store.created(key, sessionId: meta.id)
                navigator.open(.thread(environmentId: client.environment.id, sessionId: meta.id, seq: nil))
                // The chip stands in until the thread's meta lands in the host's list.
                for _ in 0..<100 where client.session(meta.id) == nil { try? await Task.sleep(for: .milliseconds(100)) }
                store.endSending(key)
            } catch {
                store.endSending(key)
                store.restore(key, draft: sent, photos: sentPhotos)
                draft = store.draft(key) ?? sent
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }
}

/// The draft row, 24 pt under the composer's row and on its edges: the type
/// chip, the host for a linked project, Master for a chat. Quiet controls in
/// the detail type and secondary, each touch reaching 44 pt.
private struct DraftRow: View {
    let draft: ProjectDraft
    @Binding var title: String
    let types: [ThreadType]
    let copies: [DraftComposer.Copy]
    let newCopyHosts: [EnvironmentClient]
    /// Why this key cannot pick Master, nil when it can.
    let masterBlock: String?
    let setType: (ThreadType) -> Void
    let setMaster: (Bool) -> Void
    let setHost: (String) -> Void
    let newCopy: (EnvironmentClient) -> Void
    /// Return in the name: back to the message.
    let titleDone: () -> Void
    @ScaledMetric(relativeTo: .caption) private var titleMin = ComposerMetrics.titleMin

    var body: some View {
        // A narrow row gives the host's name up first (its glyph stays), then lets the words truncate.
        ViewThatFits(in: .horizontal) {
            content(hostName: true, fixed: true)
            content(hostName: false, fixed: true)
            content(hostName: false, fixed: false)
        }
        .transcriptType(TranscriptType.detail)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .padding(.horizontal, ComposerMetrics.side)
        .frame(minHeight: ComposerMetrics.row)
    }

    private func content(hostName: Bool, fixed: Bool) -> some View {
        HStack(spacing: TranscriptMetrics.glyphGap * 2) {
            typeMenu
                .fixedSize()
            titleField
            if draft.threadType == .chat {
                master
                    .fixedSize(horizontal: fixed, vertical: false)
            }
            Spacer(minLength: 0)
            if copies.count > 1 || !newCopyHosts.isEmpty {
                hostMenu(showsName: hostName)
                    .fixedSize()
            }
        }
    }

    /// The thread's name, the desktop's DraftTitleField: one line sized to
    /// its words and giving way before the pickers do, the placeholder in the
    /// row's quiet color, the typed name in the primary one.
    private var titleField: some View {
        TextField("Name this thread", text: $title)
            .foregroundStyle(.primary)
            .submitLabel(.next)
            .onSubmit(titleDone)
            .textInputAutocapitalization(.sentences)
            .frame(minWidth: titleMin)
            .rowHit()
            // It gives way first: the pickers and Master's reason keep their words.
            .layoutPriority(-1)
            .accessibilityLabel("Thread name")
    }

    private var typeMenu: some View {
        Menu {
            ForEach(types, id: \.rawValue) { type in
                Button {
                    setType(type)
                } label: {
                    Label {
                        Text(type.label)
                        Text(type.hint)
                    } icon: {
                        Image(systemName: type == draft.threadType ? "checkmark" : type.symbol)
                    }
                }
            }
        } label: {
            HStack(spacing: TranscriptMetrics.wordGap) {
                Image(systemName: draft.threadType.symbol)
                    .foregroundStyle(draft.threadType.tint)
                Text(draft.threadType.label)
            }
            .rowHit()
        }
        .menuOrder(.fixed)
        .quietMenu()
        .accessibilityLabel("Thread type: \(draft.threadType.label)")
    }

    @ViewBuilder
    private var master: some View {
        if let masterBlock {
            Text(masterBlock)
                .foregroundStyle(.tertiary)
        } else {
            Button {
                setMaster(!draft.master)
            } label: {
                HStack(spacing: TranscriptMetrics.wordGap) {
                    Image(systemName: draft.master ? "checkmark.square.fill" : "square")
                        .foregroundStyle(draft.master ? Color.accentColor : Color(.secondaryLabel))
                    Text("Master thread")
                }
                .rowHit()
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(draft.master ? .isSelected : [])
        }
    }

    private func hostMenu(showsName: Bool) -> some View {
        let current = copies.first { $0.id == draft.environmentId } ?? copies.first
        return Menu {
            ForEach(copies) { copy in
                Button {
                    setHost(copy.id)
                } label: {
                    if copy.id == current?.id {
                        Label(copy.client.environment.name, systemImage: "checkmark")
                    } else {
                        Text(copy.client.environment.name)
                    }
                }
            }
            if !newCopyHosts.isEmpty {
                Section {
                    ForEach(newCopyHosts, id: \.environment.id) { client in
                        Button("New copy on \(client.environment.name)", systemImage: "plus") { newCopy(client) }
                    }
                }
            }
        } label: {
            HStack(spacing: TranscriptMetrics.wordGap) {
                Image(systemName: "desktopcomputer")
                if showsName {
                    Text(current?.client.environment.name ?? "")
                }
            }
            .rowHit()
        }
        .menuOrder(.fixed)
        .quietMenu()
        .accessibilityLabel("Host: \(current?.client.environment.name ?? "")")
    }
}
