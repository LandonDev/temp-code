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
/// the measure (`ReadingMeasure`: 768 pt, centred; a lone transcript).
struct TranscriptView: View {
    let client: EnvironmentClient
    let sessionId: String
    let thread: ThreadState
    var targetSeq: Int?
    /// The reading measure applies: a chat, a subagent, the agent detail.
    var measured = false
    @State private var window = TranscriptView.page
    /// The row the window starts at, once shown: rows arriving below never push it out.
    @State private var windowTop: TranscriptRowID?
    @State private var scrollState = TranscriptScrollState()
    @State private var targetStatus: String?
    /// Groups opened by the view itself (a search landing inside one, the
    /// proof's `group` hook); a tap toggles the row's own state.
    @State private var openGroups: Set<TranscriptRowID> = []
    /// The thread's working directory, read once: phase lines read paths relative to it.
    @State private var cwd: String?
    /// The group key each step was drawn under, so history joining above
    /// never renames a group (read and written outside observation).
    @State private var keyMemory = RowKeyMemory()
    /// Which rows were born live (read and written outside observation).
    @State private var bornRows = BornRows()
    @Environment(\.scenePhase) private var scenePhase
    /// Which turns still reveal text (A6's closing line waits on it).
    @State private var revealDrain = RevealDrain()
    /// The pin a revealing row asks for at each step (one reference; set in the body, read by rows).
    @State private var follow = TranscriptFollow()

    /// Each row's turn: the key of the message it follows.
    static func turnKeys(_ rows: [TranscriptRowModel]) -> [TranscriptRowID: Int] {
        var keys: [TranscriptRowID: Int] = [:]
        var turn: Int?
        for row in rows {
            if case .item(let entry) = row, case .user = entry.item { turn = entry.key }
            if let turn { keys[row.id] = turn }
        }
        return keys
    }

    /// Rows a cold open shows, and one page back.
    static let page = 75

    var body: some View {
        let rows = TranscriptRows.rows(thread.entries, turnOpen: thread.fold.board.turnOpen, memory: keyMemory)
        let start = TranscriptRows.windowStart(rows, top: windowTop, count: window)
        let shown = Array(rows[start...])
        let moreAbove = start > 0 || thread.moreBefore
        let turns = TranscriptView.turnKeys(rows)
        let _ = bornRows.open(thread: client.threads[sessionId])
        #if DEBUG
        let _ = LayoutProbe.note("bornOpenedAt", bornRows.openedAt.map(String.init) ?? "waiting")
        #endif
        ScrollViewReader { proxy in
            let _ = follow.pin = { pinTail(proxy: proxy) }
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
                        TranscriptRow(row: row, client: client, sessionId: sessionId, forceOpen: openGroups.contains(row.id), born: bornRows.isUnclaimed(row))
                            .equatable()
                    }
                    .modifier(BornMotion(born: bornRows.isUnclaimed(row), rises: row.isUserTurn))
                    .id(row.id)
                    .onAppear {
                        bornRows.claim(row)
                        noteOnScreen(row.id, true, order: shown)
                    }
                    .onDisappear { noteOnScreen(row.id, false, order: shown) }
                    .environment(\.revealTurn, turns[row.id])
                    .rowInitProbe(row.id)
                    .accessibilityIdentifier("transcript-item")
                    // The end row keeps its own vertical room, so a folded line takes none.
                    .listRowInsets(row.id.end ? endInsets : rowInsets)
                }
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                Color.clear
                    .frame(height: 1)
                    .id(TranscriptAnchor.bottom)
                    .background {
                        if TestHooks.scroll || TestHooks.scrollUp || TestHooks.stream {
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
            .environment(\.revealDrain, revealDrain)
            .environment(\.transcriptFollow, follow)
            .environment(\.transcriptCwd, cwd)
            .task(id: sessionId) { cwd = client.session(sessionId)?.cwd }
            // The window keeps the row it starts at; a resize clears it and the next pass records the new one.
            .onChange(of: shown.first?.id, initial: true) { _, top in windowTop = top }
            .contentMargins(.vertical, 8, for: .scrollContent)
            // The measure: the inset past the 16 pt row inset that centres a column no wider than the cap.
            .contentMargins(.horizontal, measured ? ReadingMeasure.sideInset(width: listWidth) - ReadingMeasure.edge : 0, for: .scrollContent)
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
                // A deliberate scroll away counts until the reader is back at the bottom, by any road.
                if now { scrollState.offBottomWrite = false }
                let verdict = FollowRule.atBottom(was: scrollState.atBottom, geometry: now, readerMoving: scrollState.readerMoving, offBottomWrite: scrollState.offBottomWrite)
                if scrollState.atBottom != verdict.atBottom { scrollState.atBottom = verdict.atBottom }
                if verdict.pin { pinTail(proxy: proxy) }
                #if DEBUG
                // The transcript proof: the reader leaving the bottom on its own is a jerk.
                LayoutProbe.note("atBottom", verdict.atBottom ? "1" : "0")
                #endif
            }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y } action: { _, y in
                recorder?.noteOffset(y)
                noteHold(y)
            }
            .transcriptTrace(topRow: { scrollState.topRow })
            // The reader's own scroll: the one road off the bottom besides a deliberate scroll to a row.
            .onScrollPhaseChange { _, phase in
                let moving = phase == .tracking || phase == .interacting || phase == .decelerating
                if scrollState.readerMoving != moving { scrollState.readerMoving = moving }
                if moving { scrollState.offBottomWrite = false }
            }
            .overlay(alignment: .bottom) {
                TranscriptScrollControls(state: scrollState) {
                    TranscriptTrace.write("jumpPill"); scrollState.offBottomWrite = false; withAnimation(Motion.base) { proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom) }
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
            .onChange(of: thread.fold.lastSeq) {
                pinTail(proxy: proxy)
                if hold != nil { noteHold(nil) }
            }
            // Leaving the app scrolled up puts the transcript back at the bottom before the
            // system takes its snapshot, so the return shows the newest rows with no scroll.
            .onChange(of: scenePhase) { _, phase in
                if phase == .background, FollowRule.write(for: .enteringBackground, atBottom: scrollState.atBottom) == .snap {
                    snapToBottom(proxy: proxy)
                }
                #if DEBUG
                if phase == .active { TestHooks.recordTranscript(sessionId: sessionId, state: scrollState) }
                #endif
            }
            .onChange(of: rows.count, initial: true) {
                if !rows.isEmpty, !initializedScroll, FollowRule.write(for: .opened, atBottom: true, landing: targetSeq != nil) == .snap {
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
            .task(id: TestHooks.scrollUp || TestHooks.stream ? "\(thread.isLoading)|\(rows.isEmpty)" : "") {
                guard TestHooks.scrollUp || TestHooks.stream, !thread.isLoading, !rows.isEmpty, !scrollRan else { return }
                scrollRan = true
                if TestHooks.scrollUp { await scrollUpProof() } else { await streamProof() }
            }
        }
    }

    /// The desktop's 4 px between rows of a turn, at the page's 16 pt margin.
    private var rowInsets: EdgeInsets { EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16) }
    private var endInsets: EdgeInsets { EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16) }

    @State private var initializedScroll = false
    /// The keys of the rows on screen (plain storage: an appear re-renders nothing).
    @State private var onScreen = OnScreenRows()
    @State private var proofScrollView: UIScrollView?
    @State private var scrollRan = false
    @State private var recorder: FrameRecorder?
    /// The scrolled-up run's held offsets (DEBUG proof only), outside observation so a sample re-renders nothing.
    @State private var holdBox = HoldBox()
    private var hold: TestHooks.ScrollHold? {
        get { holdBox.hold }
        nonmutating set { holdBox.hold = newValue }
    }
    @State private var proofGroupOpened = false
    /// The list's own width, for the measure.
    @State private var listWidth: CGFloat = 0
    /// The reflow's restore run; a new width step cancels and restarts it.
    @State private var reflowTask: Task<Void, Never>?
    /// An `extend` in flight: no reflow runs over it.
    @State private var extending = false

    /// The rows on screen, by their appear and disappear (no geometry, nothing
    /// per frame); the earliest in list order is the top row, the reflow's
    /// anchor for a reader off the bottom. Never moved while a reflow is open.
    private func noteOnScreen(_ id: TranscriptRowID, _ on: Bool, order: [TranscriptRowModel]) {
        if on { onScreen.ids.insert(id) } else { onScreen.ids.remove(id) }
        guard !scrollState.reflowHeld else { return }
        let top = TranscriptReflow.topRow(onScreen: onScreen.ids, order: order.map(\.id))
        guard scrollState.topRow != top else { return }
        scrollState.topRow = top
        #if DEBUG
        LayoutProbe.note("topRow", top.map(RowInitLedger.key) ?? "none")
        #endif
    }

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
            case .end: TranscriptTrace.write("reflow.end"); proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom)
            case .row(let id): TranscriptTrace.write("reflow.row \(id.key)"); scrollState.offBottomWrite = true; proxy.scrollTo(id, anchor: .top)
            }
        }
    }

    /// DEBUG only: `TC_TEST_OPEN=group` opens the first group and lands on it, once; `last-group` the last.
    private func openFirstGroupForProof(rows: [TranscriptRowModel], proxy: ScrollViewProxy) {
        let isGroup: (TranscriptRowModel) -> Bool = { if case .group = $0 { return true } else { return false } }
        guard TestHooks.open == "group" || TestHooks.open == "last-group", !proofGroupOpened, !thread.isLoading,
              let first = TestHooks.open == "group" ? rows.first(where: isGroup) : rows.last(where: isGroup) else { return }
        proofGroupOpened = true
        Motion.withoutAnimation { openGroups.insert(first.id) }
        resize(max(window, rows.count))
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(60))
            var transaction = Transaction()
            transaction.disablesAnimations = true
            TranscriptTrace.write("openGroup"); scrollState.offBottomWrite = true; withTransaction(transaction) { proxy.scrollTo(first.id, anchor: .center) }
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
        resize(rows.count)
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

    /// DEBUG proof (`TC_TEST_SCROLL_UP`): 700 pt up from the bottom once the
    /// thread has landed, then every offset is held against the one left.
    private func scrollUpProof() async {
        try? await Task.sleep(for: .seconds(2))
        guard let proofScrollView = await proofScroller() else { return }
        let top = -proofScrollView.adjustedContentInset.top
        // The proof stands in for the reader's drag.
        scrollState.offBottomWrite = true
        proofScrollView.setContentOffset(CGPoint(x: proofScrollView.contentOffset.x, y: max(top, proofScrollView.contentOffset.y - 700)), animated: false)
        try? await Task.sleep(for: .milliseconds(500))
        let y = Double(proofScrollView.contentOffset.y)
        let rows = TranscriptRows.rows(thread.entries, turnOpen: thread.fold.board.turnOpen, memory: keyMemory).count
        #if DEBUG
        LayoutProbe.note("proof", "scrolled-up")
        // The reader's row once up: the fold run holds every later stop to it.
        TestHooks.recordTranscript(sessionId: sessionId, state: scrollState)
        #endif
        hold = TestHooks.ScrollHold(startOffset: y, minOffset: y, maxOffset: y, samples: 0, rowsAtStart: rows, rows: rows,
                                    seqAtStart: thread.fold.lastSeq, seq: thread.fold.lastSeq, atBottom: scrollState.atBottom)
        noteHold(nil)
    }

    /// The list's scroll view once the probe has found it (10 s at most); the proof notes a miss.
    private func proofScroller() async -> UIScrollView? {
        for _ in 0..<100 {
            if let proofScrollView { return proofScrollView }
            try? await Task.sleep(for: .milliseconds(100))
        }
        #if DEBUG
        LayoutProbe.note("proof", "no-scroll-view")
        #endif
        return nil
    }

    /// A content offset (or, with nil, a change of rows) during the scrolled-up run.
    private func noteHold(_ y: CGFloat?) {
        guard var next = hold else { return }
        if let y {
            next.samples += 1
            next.minOffset = min(next.minOffset, Double(y))
            next.maxOffset = max(next.maxOffset, Double(y))
        }
        next.rows = TranscriptRows.rows(thread.entries, turnOpen: thread.fold.board.turnOpen, memory: keyMemory).count
        next.seq = thread.fold.lastSeq
        next.atBottom = scrollState.atBottom
        hold = next
        TestHooks.recordScrollHold(next)
    }

    /// DEBUG proof (`TC_TEST_STREAM`): frames recorded with the reader pinned
    /// at the bottom while the proof's `POST /stream` plays into the thread.
    private func streamProof() async {
        try? await Task.sleep(for: .seconds(2))
        guard let proofScrollView = await proofScroller() else { return }
        #if DEBUG
        LayoutProbe.note("proof", "stream-recording")
        #endif
        let recorder = FrameRecorder()
        self.recorder = recorder
        let state = scrollState
        let client = client
        let sessionId = sessionId
        // ThreadState is a value: read the client's current one at each call. Rows, partials included, show the stream landing.
        recorder.start(sourceRows: thread.rows.count, items: TranscriptRows.rows(thread.entries, turnOpen: thread.fold.board.turnOpen).count,
                       scrollView: proofScrollView, driver: .stream(pinned: { state.atBottom }, seq: { client.threads[sessionId]?.rows.count ?? 0 }))
        try? await Task.sleep(for: .seconds(TestHooks.streamSeconds))
        _ = recorder.stop()
        self.recorder = nil
    }

    /// The window holds the newest `count` rows from here on.
    private func resize(_ count: Int) {
        window = count
        windowTop = nil
    }

    /// The bottom, at once and with no motion: the window back to one page
    /// (the rows above are dropped, not scrolled past) and the reader pinned
    /// there as if they had never scrolled up.
    private func snapToBottom(proxy: ScrollViewProxy) {
        Motion.withoutAnimation {
            resize(Self.page)
            scrollState.atBottom = true
        }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        TranscriptTrace.write("snapToBottom window=\(window)"); scrollState.offBottomWrite = false; withTransaction(transaction) { proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom) }
    }

    /// Pin on data changes, not on scroll geometry changes. Replacing the
    /// scroll view's size anchor at an edge forces a full layout pass.
    private func pinTail(proxy: ScrollViewProxy) {
        func follows() -> Bool {
            FollowRule.write(for: .rowsChanged, atBottom: scrollState.atBottom, landing: targetStatus != nil, reflowHeld: scrollState.reflowHeld) == .pin
        }
        guard follows() else { return }
        Task { @MainActor in
            await Task.yield()
            guard follows() else { return }
            var transaction = Transaction()
            transaction.disablesAnimations = true
            TranscriptTrace.write("pinTail"); withTransaction(transaction) { proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom) }
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
              case let rows = TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen, memory: keyMemory),
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
        resize(max(window, rows.count - index + 8))
        if case .group = rows[index] { Motion.withoutAnimation { openGroups.insert(id) } }
        try? await Task.sleep(for: .milliseconds(60))
        guard !Task.isCancelled else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        TranscriptTrace.write("land \(id.key)"); scrollState.offBottomWrite = true; withTransaction(transaction) { proxy.scrollTo(id, anchor: .center) }
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
        // The sentinel shows while the reader is at the bottom and not scrolling only when the list
        // threw its offset (re-estimating rows mid-update): load the page, keep the reader at the bottom.
        let deliberate = !scrollState.atBottom || scrollState.readerMoving
        extending = true
        defer { extending = false }
        let anchorSeq = top.anchorSeq
        if rows.count > shown.count {
            resize(shown.count + Self.page)
        } else {
            await client.loadOlder(sessionId)
            resize(shown.count + olderPage)
        }
        var anchor = top.id
        if case .group = top, let anchorSeq, let state = client.threads[sessionId],
           let found = TranscriptRows.rowID(containing: anchorSeq, in: TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen, memory: keyMemory)) {
            anchor = found
        }
        try? await Task.sleep(for: .milliseconds(16))
        guard deliberate else {
            TranscriptTrace.write("extend kept bottom")
            pinTail(proxy: proxy)
            return
        }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        TranscriptTrace.write("extend \(anchor.key)"); scrollState.offBottomWrite = true; withTransaction(transaction) { proxy.scrollTo(anchor, anchor: .top) }
    }
}

/// The rows on screen, kept outside observation.
final class OnScreenRows {
    var ids: Set<TranscriptRowID> = []
}

/// Plain storage for the scrolled-up proof's samples.
final class HoldBox {
    var hold: TestHooks.ScrollHold?
}

/// Whether the reader is at the bottom. Only the jump pill reads it in a
/// body; a group row reads it once, inside the change that settles it, to
/// decide whether its close may move content. Reaching an edge must not
/// rebuild the scroll view and its lazy layout.
@MainActor @Observable
final class TranscriptScrollState {
    var atBottom = true
    /// The row at the top edge: the earliest row on screen (`noteOnScreen`); read by the reflow and the trace, never in a body.
    var topRow: TranscriptRowID?
    /// A reflow is open: `atBottom` holds its captured value.
    var reflowHeld = false
    /// The reader's finger is on the list or it is still decelerating from one.
    @ObservationIgnored var readerMoving = false
    /// The view scrolled to a row away from the bottom on purpose (a landing,
    /// a page above, a reflow's row); cleared by the reader's scroll or a write to the bottom.
    @ObservationIgnored var offBottomWrite = false
    /// The anchor the last reflow restored (the proof reads it).
    var reflowAnchor: TranscriptReflow.Anchor?
}

/// Only this control reads the position flag in its body. The pill rises in
/// and sinks out on `Motion.jump` (`fast`, 4 pt of travel; a fade under
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

/// DEBUG: the transcript proof's trace of what moves the offset. Every
/// scroll the view makes is a numbered `write` event in the layout events;
/// an offset that drops more than 200 pt and stays dropped for two frames
/// (34 ms) is a `jumpUp` event with the content height and the top row, so
/// a jump no write explains stands out. A drop the next pin puts right
/// sooner (a List re-estimating mid-update) never reaches the screen.
@MainActor
enum TranscriptTrace {
    #if DEBUG
    private static var writes = 0
    #endif

    static func write(_ cause: String) {
        #if DEBUG
        writes += 1
        LayoutProbe.note("write", "\(writes) \(cause)")
        #endif
    }
}

#if DEBUG
private struct TranscriptTraceModifier: ViewModifier {
    let topRow: () -> TranscriptRowID?
    @State private var last: CGPoint?
    /// A drop seen and not yet put right: from where, when, what it read.
    @State private var drop: (from: CGFloat, at: Date, words: String)?

    /// Two frames at 60 Hz: a drop put right sooner never reaches the screen.
    private static let visible: TimeInterval = 0.034

    func body(content: Content) -> some View {
        content.onScrollGeometryChange(for: CGPoint.self) { CGPoint(x: $0.contentSize.height, y: $0.contentOffset.y) } action: { _, now in
            if let open = drop {
                if now.y >= open.from - 200 {
                    drop = nil
                } else if Date().timeIntervalSince(open.at) >= Self.visible {
                    LayoutProbe.note("jumpUp", open.words)
                    drop = nil
                }
            } else if let last, last.y - now.y > 200 {
                drop = (last.y, Date(), "\(Int(last.y))→\(Int(now.y)) h \(Int(last.x))→\(Int(now.x)) top \(topRow()?.key ?? -1)")
            }
            last = now
        }
        .task(id: drop?.at) {
            // A drop that stays past two frames with no further geometry change is on screen too.
            guard let open = drop else { return }
            try? await Task.sleep(for: .seconds(Self.visible))
            if drop?.at == open.at { LayoutProbe.note("jumpUp", open.words); drop = nil }
        }
    }
}
#endif

extension View {
    @ViewBuilder
    func transcriptTrace(topRow: @escaping () -> TranscriptRowID?) -> some View {
        #if DEBUG
        modifier(TranscriptTraceModifier(topRow: topRow))
        #else
        self
        #endif
    }
}

/// A row born after the transcript opened arrives once: the person's
/// bubble rises 16 pt and fades in over `Motion.rise` (the drawer curve,
/// 0.24 s), any other row fades in over `fast`; under reduced motion both
/// fade over `fast`. A row seen before (first paint, scroll back, a remount
/// after its claim) is simply there.
private struct BornMotion: ViewModifier {
    let born: Bool
    let rises: Bool
    @State private var arrived: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let rise: CGFloat = 16

    init(born: Bool, rises: Bool) {
        self.born = born
        self.rises = rises
        _arrived = State(initialValue: !born)
    }

    func body(content: Content) -> some View {
        content
            .opacity(arrived ? 1 : 0)
            .offset(y: arrived || reduceMotion || !rises ? 0 : Self.rise)
            .onAppear {
                guard !arrived else { return }
                withAnimation(rises && !reduceMotion ? Motion.rise : Motion.fast) { arrived = true }
            }
    }
}

private extension TranscriptRowModel {
    /// The person's own message.
    var isUserTurn: Bool {
        if case .item(let entry) = self, case .user = entry.item { return true }
        return false
    }
}
