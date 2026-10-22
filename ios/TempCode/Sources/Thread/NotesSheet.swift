import SwiftUI
import TempCodeClient
import TempCodeContract

/// The thread bar's notes glyph: `note.text`, with a dot when the notes
/// changed since this device last read them. Tapping presents the sheet.
struct NotesButton: View {
    let client: EnvironmentClient
    let sessionId: String
    @State private var showing = false
    @AppStorage private var readAt: Double

    init(client: EnvironmentClient, sessionId: String) {
        self.client = client
        self.sessionId = sessionId
        _readAt = AppStorage(wrappedValue: 0, NotesRead.key(sessionId))
    }

    var body: some View {
        let doc = client.notes[sessionId]?.doc
        let unread = Notes.unread(updatedAt: doc?.updatedAt, readAt: readAt == 0 ? nil : readAt)
        Button { showing = true } label: {
            Image(systemName: "note.text")
                .overlay(alignment: .topTrailing) {
                    if unread {
                        Circle()
                            .fill(Color(.secondaryLabel))
                            .frame(width: NotesStyles.dot, height: NotesStyles.dot)
                            .offset(x: 3, y: -2)
                            .transition(.identity)
                    }
                }
        }
        .accessibilityLabel(unread ? "Notes, updated" : "Notes")
        .task(id: sessionId) { _ = await client.loadNotes(sessionId) }
        .sheet(isPresented: $showing) { NotesSheet(client: client, sessionId: sessionId) }
    }
}

/// When this device last read each thread's notes: the dot answers "did
/// this phone read the latest", so the mark is per device and never synced.
enum NotesRead {
    static func key(_ id: String) -> String { "thread.notesRead.\(id)" }

    static func mark(_ id: String, _ updatedAt: Double?) {
        guard let updatedAt else { return }
        UserDefaults.standard.set(updatedAt, forKey: key(id))
    }
}

/// The thread's notes at the large detent: the five sections as a page,
/// Edit for the whole text, the menu for Copy as brief. A push while open
/// replaces the sections in place and keeps the reader's section where it
/// was; swiping down saves whatever the editor holds.
struct NotesSheet: View {
    let client: EnvironmentClient
    let sessionId: String
    @State private var editor: NotesEditor
    @State private var painted = false
    @State private var copied = 0
    @FocusState private var focused: Bool

    init(client: EnvironmentClient, sessionId: String) {
        self.client = client
        self.sessionId = sessionId
        _editor = State(initialValue: NotesEditor { try await client.saveNotes(sessionId, text: $0) })
    }

    var body: some View {
        let state = client.notes[sessionId]
        let doc = state?.doc
        let block = client.operateBlock
        let readOnly = block.map { !$0.isTransient } ?? false
        let current = editor.editing ? editor.draft : (doc?.text ?? "")
        NavigationStack {
            Group {
                if editor.editing {
                    editorPage(doc: doc)
                } else if let doc {
                    NotesDocument(display: Notes.display(doc.text), environmentId: client.environment.id, sessionId: sessionId, painted: painted)
                } else if state?.isLoading != false {
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                } else {
                    failed(state?.error)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Surface.background)
            .navigationTitle("Notes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Surface.background, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Button("Copy as brief", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = Notes.brief(current, title: client.session(sessionId)?.title ?? "Untitled")
                            copied += 1
                        }
                        .disabled(doc == nil || Notes.isEmpty(current))
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("More")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if readOnly, let block {
                        Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
                    } else if editor.editing {
                        Button("Done") {
                            Task {
                                await editor.finish()
                                focused = false
                            }
                        }
                        .font(.body.weight(.semibold))
                    } else {
                        Button("Edit") { editor.begin(from: doc) }
                        .disabled(doc == nil)
                    }
                }
            }
        }
        .presentationDetents([.large])
        .presentationCornerRadius(Radius.sheet)
        .sensoryFeedback(.impact(weight: .light), trigger: copied)
        .task { _ = await client.loadNotes(sessionId, refresh: true) }
        // Read as it lands, the sheet being open.
        .onChange(of: doc?.updatedAt, initial: true) { NotesRead.mark(sessionId, doc?.updatedAt) }
        // Nothing animates until the first document has painted.
        .onChange(of: doc == nil, initial: true) {
            guard doc != nil, !painted else { return }
            Task {
                await Task.yield()
                painted = true
            }
        }
        .onDisappear {
            let editor = editor
            Task { await editor.flush() }
        }
    }

    /// The fetch failed and nothing is held: one line, the reason, Retry.
    private func failed(_ error: ActionError?) -> some View {
        VStack(spacing: 8) {
            Text("Couldn't load notes")
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let message = error?.message, !message.isEmpty {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
            PillButton("Retry") { Task { _ = await client.loadNotes(sessionId, refresh: true) } }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, NotesStyles.inset)
        .padding(.top, 40)
    }

    /// The whole file in a plain body-size editor; one quiet line under it
    /// only when something needs saying, the remote change winning over the
    /// failed save.
    private func editorPage(doc: ThreadNotesDoc?) -> some View {
        let theirs = editor.remoteChanged(doc)
        return VStack(spacing: 0) {
            TextEditor(text: Binding(get: { editor.draft }, set: { editor.change($0) }))
                .font(.body)
                .scrollContentBackground(.hidden)
                .textInputAutocapitalization(.sentences)
                .focused($focused)
                // The keyboard comes up once the editor is on screen, not in the update that inserts it.
                .onAppear { focused = true }
                // TextEditor's own 5 pt text inset keeps the page's 20 pt edge.
                .padding(.horizontal, NotesStyles.inset - 5)
                .padding(.top, NotesStyles.pageTop - 8)
                .accessibilityLabel("Notes text")
            if theirs || editor.state == .failed {
                HStack(spacing: 12) {
                    Text(theirs ? "The thread updated the notes meanwhile" : "Not saved")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if theirs {
                        PillButton("Load theirs") { editor.loadTheirs(doc) }
                    }
                }
                .padding(.horizontal, NotesStyles.inset)
                .padding(.vertical, 8)
                .background(.bar)
            }
        }
    }
}

/// The five sections as a page: headings in `.headline`, bodies through the
/// plan page's block stack (PlanBlockView, PlanType's spacing), an empty
/// section folded to its heading in tertiary, extras after. Keyed by heading
/// so a push replaces a body in place and the reader's section stays anchored.
private struct NotesDocument: View {
    let display: ParsedNotes
    let environmentId: String
    let sessionId: String
    let painted: Bool
    @State private var position = ScrollPosition(idType: String.self)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: NotesStyles.sectionGap) {
                if !display.preamble.isEmpty {
                    NotesBody(text: display.preamble, key: NotesStyles.key(environmentId, sessionId, "\u{0}preamble"))
                        .id("\u{0}preamble")
                }
                ForEach(display.sections, id: \.heading) { section in
                    NotesSectionView(section: section, key: NotesStyles.key(environmentId, sessionId, section.heading), painted: painted)
                        .id(section.heading)
                }
            }
            .scrollTargetLayout()
            .padding(.horizontal, NotesStyles.inset)
            .padding(.top, NotesStyles.pageTop)
            .padding(.bottom, NotesStyles.pageBottom)
            .frame(maxWidth: NotesStyles.measure, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollPosition($position, anchor: .top)
        .textSelection(.enabled)
        .transaction { if !painted { $0.animation = nil } }
    }
}

/// One section: the heading, tertiary while empty, and the body cross-fading
/// in when it changes. Nothing else moves.
private struct NotesSectionView: View {
    let section: NoteSection
    let key: String
    let painted: Bool

    var body: some View {
        let empty = section.body.isEmpty
        VStack(alignment: .leading, spacing: NotesStyles.headingGap) {
            Text(section.heading)
                .font(.headline)
                .foregroundStyle(empty ? Color(.tertiaryLabel) : Color(.label))
                .animation(painted ? Motion.crossFade : nil, value: empty)
            if !empty {
                NotesBody(text: section.body, key: key)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(empty ? "\(section.heading), empty" : section.heading)
    }
}

/// A section's markdown as plan blocks, parsed through the plan pages' cache
/// (short text on first paint, off the main actor after, the old document
/// kept until the new one lands). The old and new bodies overlap while they
/// cross-fade, so the page never jumps twice.
private struct NotesBody: View {
    let text: String
    let key: String

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let document = ThreadCaches.plans.document(key, text: text) {
                VStack(alignment: .leading, spacing: PlanType.gap) {
                    ForEach(Array(document.blocks.enumerated()), id: \.offset) { index, block in
                        PlanBlockView(block: block, first: index == 0)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .id(document.textHash)
                .transition(.opacity.animation(Motion.crossFade))
            } else {
                Text(text)
                    .font(.body)
                    .lineSpacing(PlanType.lineSpacing)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
