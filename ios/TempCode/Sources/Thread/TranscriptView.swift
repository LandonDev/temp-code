import SwiftUI
import UIKit
import Observation
import TempCodeClient
import TempCodeContract

/// The transcript: the newest 75 rows, one page more each time the top is
/// reached, pinned to the bottom while the user is there, a "Jump to
/// latest" pill once they scroll up. The rows are the row model's rows
/// (`TranscriptRows`): an entry on its own, a fold of settled tool chips, a
/// settled turn's closing line. Rows keep their identity by the model's
/// stable ids and compare by value, so a streaming row updates its own text
/// and nothing above it is laid out again. Nothing animates on first paint:
/// every scroll the view makes on its own runs in a transaction with
/// animations off, and the only animated changes are the ones a tap starts.
///
/// A width change (a fold, an unfold, the shell's sidebar, the pager
/// becoming two panes) keeps the end when the reader is there and the row
/// at the top edge otherwise (`TranscriptReflow`): the anchor is captured
/// once, `atBottom` is held at that value while the geometry flickers, and
/// the anchor is restored without animation at each of the reflow's delays,
/// each new width step restarting the run. With `measured` the rows read at
/// the measure (`ReadingMeasure`: 640 pt, centred; a lone transcript).
struct TranscriptView: View {
    let client: EnvironmentClient
    let sessionId: String
    let thread: ThreadState
    var targetSeq: Int?
    /// The reading measure applies: a chat, a subagent, the agent detail.
    var measured = false
    @State private var window = TranscriptView.page
    @State private var scrollState = TranscriptScrollState()
    @State private var targetStatus: String?
    /// Groups opened by the view itself (a search landing inside one, the
    /// proof's `group` hook); a tap toggles the row's own state.
    @State private var openGroups: Set<TranscriptRowID> = []
    /// The thread's working directory, read once: phase lines read paths relative to it.
    @State private var cwd: String?
    @Environment(\.scenePhase) private var scenePhase

    /// Rows a cold open shows, and one page back.
    static let page = 75

    var body: some View {
        let rows = TranscriptRows.rows(thread.entries, turnOpen: thread.fold.board.turnOpen)
        let shown = rows.count > window ? Array(rows.suffix(window)) : rows
        let moreAbove = rows.count > window || thread.moreBefore
        ScrollViewReader { proxy in
            List {
                if moreAbove {
                    TopSentinel(loading: thread.isLoadingOlder) {
                        await extend(proxy: proxy, rows: rows, shown: shown)
                    }
                    .listRowInsets(rowInsets)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                } else if rows.isEmpty {
                    EmptyTranscript(thread: thread)
                        .listRowInsets(rowInsets)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                ForEach(shown) { row in
                    VStack(alignment: .leading, spacing: 0) {
                        TranscriptRow(row: row, client: client, sessionId: sessionId, forceOpen: openGroups.contains(row.id))
                            .equatable()
                    }
                    .id(row.id)
                    .accessibilityIdentifier("transcript-item")
                }
                .listRowInsets(rowInsets)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                Color.clear
                    .frame(height: 1)
                    .id(TranscriptAnchor.bottom)
                    .background {
                        if TestHooks.scroll {
                            ScrollProofProbe { scroll in if proofScrollView !== scroll { proofScrollView = scroll } }
                        }
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 0)
            .environment(scrollState)
            .environment(\.transcriptCwd, cwd)
            .task(id: sessionId) { cwd = client.session(sessionId)?.cwd }
            .contentMargins(.vertical, 8, for: .scrollContent)
            // The measure: the inset past the 16 pt row inset that centres a column no wider than the cap.
            .contentMargins(.horizontal, measured ? ReadingMeasure.sideInset(width: listWidth) - ReadingMeasure.edge : 0, for: .scrollContent)
            // Read only, never assigned: the row at the top edge, for the reflow's anchor.
            .scrollPosition(id: Binding(get: { scrollState.topRow }, set: { scrollState.topRow = $0 }), anchor: .top)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { was, now in
                listWidth = now
                if TranscriptReflow.widthChanged(was, now) { reflow(proxy: proxy) }
            }
            .navigationLinkIndicatorVisibility(.hidden)
            .buttonStyle(.plain)
            .scrollBounceBehavior(.basedOnSize)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .alignment)
            .defaultScrollAnchor(.bottom, for: .sizeChanges)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                // Content shorter than the screen is "at the bottom" too.
                geometry.contentSize.height <= geometry.containerSize.height || geometry.visibleRect.maxY >= geometry.contentSize.height - 64
            } action: { _, now in
                // Held at the captured value while a reflow is open: the geometry flickers mid-fold.
                guard !scrollState.reflowHeld else { return }
                scrollState.atBottom = now
            }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y } action: { _, y in
                recorder?.noteOffset(y)
            }
            .overlay(alignment: .bottom) {
                TranscriptScrollControls(state: scrollState) {
                    withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom) }
                }
            }
            .overlay(alignment: .top) {
                if let targetStatus {
                    Text(targetStatus)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(8)
                        .background(Surface.raised)
                        .accessibilityIdentifier("search-target-status")
                }
            }
            .onChange(of: thread.fold.lastSeq) { pinTail(proxy: proxy) }
            // Leaving the app scrolled up puts the transcript back at the bottom before the
            // system takes its snapshot, so the return shows the newest rows with no scroll.
            .onChange(of: scenePhase) { _, phase in
                if TranscriptLanding.snapsToBottom(enteringBackground: phase == .background, atBottom: scrollState.atBottom) {
                    snapToBottom(proxy: proxy)
                }
                #if DEBUG
                if phase == .active { TestHooks.recordTranscript(sessionId: sessionId, state: scrollState) }
                #endif
            }
            .onChange(of: rows.count, initial: true) {
                if !rows.isEmpty, !initializedScroll, targetSeq == nil {
                    initializedScroll = true
                    Task { @MainActor in
                        await Task.yield()
                        // A thread always opens at its newest row, with no motion (TranscriptLanding).
                        snapToBottom(proxy: proxy)
                        #if DEBUG
                        TestHooks.recordTranscript(sessionId: sessionId, state: scrollState)
                        #endif
                    }
                } else { pinTail(proxy: proxy) }
                openFirstGroupForProof(rows: rows, proxy: proxy)
            }
            .task(id: thread.isLoading) {
                guard !thread.isLoading, client.threads[sessionId] != nil else { return }
                await land(proxy: proxy)
            }
            .task(id: thread.isLoading) {
                guard TestHooks.scroll, !thread.isLoading, !rows.isEmpty, !scrollRan else { return }
                scrollRan = true
                await scrollProof(proxy: proxy)
            }
        }
    }

    /// The desktop's 4 px between rows of a turn, at the page's 16 pt margin.
    private var rowInsets: EdgeInsets { EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16) }

    @State private var initializedScroll = false
    @State private var proofScrollView: UIScrollView?
    @State private var scrollRan = false
    @State private var recorder: FrameRecorder?
    @State private var proofGroupOpened = false
    /// The list's own width, for the measure.
    @State private var listWidth: CGFloat = 0
    /// The reflow's restore run; a new width step cancels and restarts it.
    @State private var reflowTask: Task<Void, Never>?
    /// An `extend` in flight: no reflow runs over it.
    @State private var extending = false

    /// The width changed: capture the anchor once (or keep the one a step
    /// already captured), hold `atBottom`, and restore at each delay with
    /// no animation. Nothing runs while a landing or an extend is in flight.
    private func reflow(proxy: ScrollViewProxy) {
        guard targetStatus == nil, !extending else { return }
        let anchor: TranscriptReflow.Anchor
        if scrollState.reflowHeld, let held = scrollState.reflowAnchor {
            anchor = held
        } else {
            guard let fresh = TranscriptReflow.anchor(atBottom: scrollState.atBottom, topRow: scrollState.topRow) else { return }
            anchor = fresh
            scrollState.reflowAnchor = fresh
            #if DEBUG
            TestHooks.recordTranscript(sessionId: sessionId, state: scrollState)
            #endif
        }
        reflowTask?.cancel()
        scrollState.reflowHeld = true
        reflowTask = Task { @MainActor in
            var elapsed = 0
            for delay in TranscriptReflow.restoreDelaysMs {
                if delay > elapsed {
                    try? await Task.sleep(for: .milliseconds(delay - elapsed))
                    elapsed = delay
                }
                guard !Task.isCancelled else { return }
                restore(anchor, proxy: proxy)
            }
            scrollState.reflowHeld = false
            reflowTask = nil
            #if DEBUG
            TestHooks.recordTranscript(sessionId: sessionId, state: scrollState)
            #endif
        }
    }

    private func restore(_ anchor: TranscriptReflow.Anchor, proxy: ScrollViewProxy) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            switch anchor {
            case .end: proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom)
            case .row(let id): proxy.scrollTo(id, anchor: .top)
            }
        }
    }

    /// DEBUG only: `TC_TEST_OPEN=group` opens the first group and lands on it, once.
    private func openFirstGroupForProof(rows: [TranscriptRowModel], proxy: ScrollViewProxy) {
        guard TestHooks.open == "group", !proofGroupOpened, !thread.isLoading,
              let first = rows.first(where: { if case .group = $0 { return true } else { return false } }) else { return }
        proofGroupOpened = true
        Motion.withoutAnimation { openGroups.insert(first.id) }
        window = max(window, rows.count)
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(60))
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { proxy.scrollTo(first.id, anchor: .center) }
        }
    }

    /// Every row in the window, then a 25 s glide to the top and back while
    /// the frames are recorded.
    private func scrollProof(proxy: ScrollViewProxy) async {
        // Load the fixture before timing: hitting the top must not fetch a
        // page and refold while the display link measures the scroll.
        for _ in 0..<100 {
            guard !Task.isCancelled, let state = client.threads[sessionId], state.moreBefore,
                  let first = state.rows.first?.seq else { break }
            if state.isLoadingOlder {
                try? await Task.sleep(for: .milliseconds(20))
                continue
            }
            await client.loadOlder(sessionId)
            guard let now = client.threads[sessionId]?.rows.first?.seq, now < first else { break }
        }
        guard let state = client.threads[sessionId], !state.moreBefore, !state.entries.isEmpty else { return }
        let rows = TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen)
        window = rows.count
        try? await Task.sleep(for: .seconds(2))
        var setup = Transaction()
        setup.disablesAnimations = true
        withTransaction(setup) { proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom) }
        try? await Task.sleep(for: .seconds(2))
        guard let proofScrollView else { return }
        let recorder = FrameRecorder()
        self.recorder = recorder
        recorder.start(sourceRows: state.rows.count, items: rows.count, scrollView: proofScrollView)
        // List uses UIKit's fixed-duration scrollTo animation. Drive its
        // native offset continuously for two measured 25-second glides.
        try? await Task.sleep(for: .seconds(52))
        _ = recorder.stop()
        self.recorder = nil
    }

    /// The bottom, at once and with no motion: the window back to one page
    /// (the rows above are dropped, not scrolled past) and the reader pinned
    /// there as if they had never scrolled up.
    private func snapToBottom(proxy: ScrollViewProxy) {
        Motion.withoutAnimation {
            window = Self.page
            scrollState.atBottom = true
        }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom) }
    }

    /// Pin on data changes, not on scroll geometry changes. Replacing the
    /// scroll view's size anchor at an edge forces a full layout pass.
    private func pinTail(proxy: ScrollViewProxy) {
        guard scrollState.atBottom, targetStatus == nil else { return }
        Task { @MainActor in
            await Task.yield()
            guard scrollState.atBottom, targetStatus == nil else { return }
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom) }
        }
    }

    /// Opens on the asked row once it is in the loaded rows: the window
    /// widens to hold it, a group holding it is opened first (no animation),
    /// and the row lands centred.
    private func land(proxy: ScrollViewProxy) async {
        guard let targetSeq else { return }
        targetStatus = "Loading search result…"
        guard let seq = await client.reveal(sessionId, seq: targetSeq),
              let state = client.threads[sessionId],
              case let rows = TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen),
              let id = TranscriptRows.rowID(containing: seq, in: rows),
              let index = rows.firstIndex(where: { $0.id == id }) else {
            if !Task.isCancelled {
                targetStatus = "Search result could not be found."
                TestHooks.recordNavigation(target: targetSeq, item: nil, oldest: client.threads[sessionId]?.rows.first?.seq)
            }
            return
        }
        guard !Task.isCancelled else { return }
        targetStatus = nil
        TestHooks.recordNavigation(target: targetSeq, item: seq, oldest: client.threads[sessionId]?.rows.first?.seq)
        window = max(window, rows.count - index + 8)
        if id.kind == .group { Motion.withoutAnimation { openGroups.insert(id) } }
        try? await Task.sleep(for: .milliseconds(60))
        guard !Task.isCancelled else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { proxy.scrollTo(id, anchor: .center) }
        #if DEBUG
        TestHooks.recordTranscript(sessionId: sessionId, state: scrollState)
        #endif
    }

    /// One page back: rows already held, then older ones from the cache or
    /// the host. The row that was at the top stays where it is: it is found
    /// again by the seq it showed, since an older chip joining a group at
    /// the top changes that group's id.
    private func extend(proxy: ScrollViewProxy, rows: [TranscriptRowModel], shown: [TranscriptRowModel]) async {
        guard let top = shown.first else { return }
        extending = true
        defer { extending = false }
        let anchorSeq = top.anchorSeq ?? top.id.seq
        if rows.count > window {
            window += Self.page
        } else {
            await client.loadOlder(sessionId)
            window += olderPage
        }
        var anchor = top.id
        if case .group = top, let state = client.threads[sessionId],
           let found = TranscriptRows.rowID(containing: anchorSeq, in: TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen)) {
            anchor = found
        }
        try? await Task.sleep(for: .milliseconds(16))
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { proxy.scrollTo(anchor, anchor: .top) }
    }
}

/// Whether the reader is at the bottom. Only the jump pill reads it in a
/// body; a group row reads it once, inside the change that settles it, to
/// decide whether its close may move content. Reaching an edge must not
/// rebuild the scroll view and its lazy layout.
@MainActor @Observable
final class TranscriptScrollState {
    var atBottom = true
    /// The row at the top edge, as the list reports it; never assigned by the view.
    var topRow: TranscriptRowID?
    /// A reflow is open: `atBottom` holds its captured value.
    var reflowHeld = false
    /// The anchor the last reflow restored (the proof reads it).
    var reflowAnchor: TranscriptReflow.Anchor?
}

/// Only this control reads the position flag in its body. The pill rises in
/// and sinks out on `Motion.jump` (150 ms, 8 pt of travel; a fade under
/// reduced motion).
private struct TranscriptScrollControls: View {
    let state: TranscriptScrollState
    let jump: () -> Void

    var body: some View {
        VStack {
            if !state.atBottom {
                JumpPill(jump: jump)
                    .jumpTransition()
            }
        }
        .padding(.bottom, 12)
        .animation(Motion.jump, value: state.atBottom)
    }
}

enum TranscriptAnchor: Hashable {
    case bottom
}

extension TranscriptRowModel {
    /// The seq a row stands for in scroll memory: an item's own, a group's
    /// first chip's; a turn's closing line stands for nothing (its user row
    /// is far above it).
    var anchorSeq: Int? {
        switch self {
        case .item(let entry): entry.seq
        case .group(let group): group.entries[0].seq
        case .turnEnd, .thinkingTail: nil
        }
    }
}

private struct TopSentinel: View {
    let loading: Bool
    let reach: () async -> Void

    var body: some View {
        HStack {
            Spacer()
            ProgressView()
                .controlSize(.small)
                .opacity(loading ? 1 : 0)
            Spacer()
        }
        .frame(height: 24)
        .onAppear { Task { await reach() } }
    }
}

private struct EmptyTranscript: View {
    let thread: ThreadState

    var body: some View {
        HStack {
            Spacer()
            if thread.isLoading {
                ProgressView()
            } else if let gone = thread.goneReason {
                Text(gone)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ContentUnavailableView("No Messages Yet", systemImage: "bubble.left.and.bubble.right")
            }
            Spacer()
        }
        .padding(.top, 40)
    }
}

/// The one floating control in the transcript: a glass capsule (36 pt, its
/// hit area 44) over the rows, the arrow 2 pt closer to its edge than the
/// text is to the other, so the pair reads centered.
private struct JumpPill: View {
    let jump: () -> Void

    var body: some View {
        Button(action: jump) {
            HStack(spacing: 5) {
                Image(systemName: "arrow.down")
                    .font(.footnote.weight(.medium))
                    .imageScale(.small)
                Text("Jump to latest")
                    .font(.footnote.weight(.medium))
            }
            .foregroundStyle(Color.primary)
            .padding(.leading, 12)
            .padding(.trailing, 14)
            .padding(.vertical, 8)
            .frame(minHeight: 36)
            .tcGlass(in: Capsule(), interactive: true)
            .padding(.vertical, 4)
            .contentShape(Capsule())
        }
        .buttonStyle(.pressable)
    }
}
