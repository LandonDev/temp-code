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
    @Environment(AppModel.self) private var app
    /// The group key each step was drawn under, so history joining above
    /// never renames a group (read and written outside observation).
    @State private var keyMemory = RowKeyMemory()
    /// Which rows were born live (read and written outside observation).
    @State private var bornRows = BornRows()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.markdownScope) private var markdownScope
    /// Which turns still reveal text (A6's closing line waits on it).
    @State private var revealDrain = RevealDrain()
    /// The pin a revealing row asks for at each step (one reference; set in the body, read by rows).
    @State private var follow = TranscriptFollow()
    /// The statuses of the agents the omitted waits still need (`watchWaits`).
    @State private var waitRead = WaitStatuses()

    /// Rows a cold open shows, and one page back.
    static let page = 75

    var body: some View {
        let rows = TranscriptRows.rows(thread.entries, turnOpen: thread.fold.board.turnOpen, memory: keyMemory, waits: thread.fold.waitOutcomes, statusOf: waitStatus)
        // The agents whose status the omitted waits still need, after this pass kept what it read.
        let waitIds = WaitSteps.unsettledAgents(thread.entries, memory: thread.fold.waitOutcomes)
        let start = TranscriptRows.windowStart(rows, top: windowTop, count: window)
        let shown = Array(rows[start...])
        let moreAbove = start > 0 || thread.moreBefore
        let turns = TranscriptRows.turnKeys(rows)
        let gaps = TranscriptView.gaps(rows, from: start)
        let _ = bornRows.open(thread: client.threads[sessionId])
        #if DEBUG
        let _ = LayoutProbe.note("bornOpenedAt", bornRows.openedAt.map(String.init) ?? "waiting")
        #endif
        ScrollViewReader { proxy in
            let _ = follow.pin = { pinTail(proxy: proxy) }
            let _ = follow.resize = { change in handResize(proxy: proxy, change) }
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
                    // The gap above each row is the boundary's (`RowGap`); the end
                    // row carries its own inside its fold, so a folded line takes none.
                    .listRowInsets(row.id.end ? endInsets : gapInsets(gaps[row.id] ?? TranscriptMetrics.Gap.block))
                }
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                // The room under the last row, and the anchor the pins scroll to.
                Color.clear
                    .frame(height: TranscriptMetrics.Gap.last)
                    .id(TranscriptAnchor.bottom)
                    .background {
                        // The list's own scroll view: a restore reads a row's frame from its layout.
                        ScrollProofProbe { scroll in
                            listScroll.scroll = scroll
                            if (TestHooks.scroll || TestHooks.scrollUp || TestHooks.stream), proofScrollView !== scroll { proofScrollView = scroll }
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
            .task(id: waitIds) { await watchWaits(waitIds) }
            // The window keeps the row it starts at; a resize clears it and the next pass records the new one.
            .onChange(of: shown.first?.id, initial: true) { _, top in windowTop = top }
            // The window's settled replies parse off the main actor before their rows mount, newest first.
            .onChange(of: "\(shown.first?.id.key ?? 0)|\(shown.count)|\(thread.fold.lastSeq)", initial: true) { prefetch(shown) }
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
                let verdict = FollowRule.atBottom(was: scrollState.atBottom, geometry: now, readerMoving: scrollState.readerMoving,
                                                  offBottomWrite: scrollState.offBottomWrite, gliding: scrollState.glide.active(at: TranscriptView.now))
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
            // Keyed by the target too: a new row named to an open transcript lands again.
            .task(id: "\(thread.isLoading)|\(targetSeq ?? -1)") {
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

    /// The sentinel's and the empty state's room, at the page's 16 pt margin.
    private var rowInsets: EdgeInsets { EdgeInsets(top: TranscriptMetrics.Gap.line, leading: ReadingMeasure.edge, bottom: TranscriptMetrics.Gap.line, trailing: ReadingMeasure.edge) }
    private var endInsets: EdgeInsets { gapInsets(0) }
    private func gapInsets(_ top: CGFloat) -> EdgeInsets { EdgeInsets(top: top, leading: ReadingMeasure.edge, bottom: 0, trailing: ReadingMeasure.edge) }

    /// The gap above each shown row (`RowGap.above`), read from the row
    /// before it in the whole list, so the window's first row keeps the gap
    /// it had under the row above the window.
    static func gaps(_ rows: [TranscriptRowModel], from start: Int) -> [TranscriptRowID: CGFloat] {
        var gaps: [TranscriptRowID: CGFloat] = [:]
        gaps.reserveCapacity(rows.count - start)
        for index in rows.indices.dropFirst(start) {
            gaps[rows[index].id] = CGFloat(RowGap.above(rows[index], after: index > 0 ? rows[index - 1] : nil))
        }
        return gaps
    }

    @State private var initializedScroll = false
    /// The pin the turn's asks coalesce into (plain storage).
    @State private var pins = PinQueue()
    /// The keys of the rows on screen (plain storage: an appear re-renders nothing).
    @State private var onScreen = OnScreenRows()
    @State private var proofScrollView: UIScrollView?
    /// The list's scroll view and the reader's place a restore keeps (plain storage).
    @State private var listScroll = ListScroll()
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

    /// Starts the parse of every settled reply in the window that has none,
    /// newest first, so each row draws styled from its first frame.
    private func prefetch(_ rows: [TranscriptRowModel]) {
        for row in rows.reversed() {
            guard case .item(let entry) = row, case .assistant(let block) = entry.item, !block.streaming else { continue }
            ThreadCaches.markdown.prefetch(scope: markdownScope, seq: block.seq, text: block.text)
        }
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
            if case .row(let id) = fresh { listScroll.place = place(of: id) }
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
        // The row is at the top edge, laid out at the new width: the reader's place inside it.
        if case .row(let id) = anchor, let held = listScroll.place {
            Task { @MainActor in
                await Task.yield()
                settle(id, at: held, rewrapped: true)
            }
        }
    }

    /// The window as the list holds it now: its rows' ids, and the rows above them (the sentinel, the empty state).
    private func currentWindow() -> (shown: [TranscriptRowID], lead: Int) {
        guard let state = client.threads[sessionId] else { return ([], 0) }
        let rows = TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen, memory: keyMemory, waits: state.fold.waitOutcomes, statusOf: waitStatus)
        let start = TranscriptRows.windowStart(rows, top: windowTop, count: window)
        return (rows[start...].map(\.id), start > 0 || state.moreBefore || rows.isEmpty ? 1 : 0)
    }

    /// The row's frame in the list's own layout: where its top sits against the top edge.
    private func frame(of id: TranscriptRowID) -> (UICollectionView, CGRect)? {
        guard let list = listScroll.scroll as? UICollectionView, list.numberOfSections == 1 else { return nil }
        let (shown, lead) = currentWindow()
        guard let item = TranscriptReflow.item(of: id, shown: shown, lead: lead, items: list.numberOfItems(inSection: 0)),
              let frame = list.layoutAttributesForItem(at: IndexPath(item: item, section: 0))?.frame else { return nil }
        return (list, frame)
    }

    /// Where the reader is inside the row, read before a restore moves anything.
    private func place(of id: TranscriptRowID) -> TranscriptReflow.Place? {
        guard let (list, frame) = frame(of: id) else { return nil }
        return TranscriptReflow.Place(rowTop: frame.minY, rowHeight: frame.height, edge: list.contentOffset.y + list.adjustedContentInset.top)
    }

    /// Puts the reader back at `place` inside the row, which a scroll to its
    /// top has laid out: the same share of a re-wrapped row above the edge,
    /// else the same points. No motion; a row the layout cannot find stays at its top.
    private func settle(_ id: TranscriptRowID, at place: TranscriptReflow.Place, rewrapped: Bool) {
        guard let (list, frame) = frame(of: id) else { return }
        let inset = list.adjustedContentInset
        let lowest = -inset.top
        let highest = max(lowest, list.contentSize.height + inset.bottom - list.bounds.height)
        let y = min(highest, max(lowest, place.edge(rowTop: frame.minY, rowHeight: frame.height, rewrapped: rewrapped) - inset.top))
        guard abs(y - list.contentOffset.y) > 0.5 else { return }
        TranscriptTrace.write("place \(id.key)")
        scrollState.offBottomWrite = true
        list.setContentOffset(CGPoint(x: list.contentOffset.x, y: y), animated: false)
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
        let rows = TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen, waits: state.fold.waitOutcomes, statusOf: waitStatus)
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
        let rows = TranscriptRows.rows(thread.entries, turnOpen: thread.fold.board.turnOpen, memory: keyMemory, waits: thread.fold.waitOutcomes, statusOf: waitStatus).count
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
        next.rows = TranscriptRows.rows(thread.entries, turnOpen: thread.fold.board.turnOpen, memory: keyMemory, waits: thread.fold.waitOutcomes, statusOf: waitStatus).count
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
        recorder.start(sourceRows: thread.rows.count, items: TranscriptRows.rows(thread.entries, turnOpen: thread.fold.board.turnOpen, waits: thread.fold.waitOutcomes, statusOf: waitStatus).count,
                       scrollView: proofScrollView, driver: .stream(pinned: { state.atBottom }, seq: { client.threads[sessionId]?.rows.count ?? 0 }))
        if TestHooks.streamDrag {
            try? await Task.sleep(for: .seconds(4))
            await dragHoldProof(proofScrollView)
            try? await Task.sleep(for: .seconds(max(0, TestHooks.streamSeconds - 9)))
        } else {
            try? await Task.sleep(for: .seconds(TestHooks.streamSeconds))
        }
        _ = recorder.stop()
        self.recorder = nil
    }

    /// DEBUG proof (`TC_TEST_STREAM_DRAG`): a finger stands in for a slow
    /// drag 40 pt up mid-stream, inside the bottom's 64 pt slack, and holds
    /// 3 s while the reply keeps streaming. Every offset of the hold is kept
    /// against the one the drag left, and the pins that ran are counted:
    /// nothing may pull the reader back while the finger is down.
    private func dragHoldProof(_ scroll: UIScrollView) async {
        let state = scrollState
        state.readerMoving = true
        for _ in 0..<20 {
            scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: scroll.contentOffset.y - 2), animated: false)
            try? await Task.sleep(for: .milliseconds(50))
        }
        let held = scroll.contentOffset.y
        let pinsBefore = pins.ran
        var low = held, high = held, samples = 0
        let rowsBefore = client.threads[sessionId]?.rows.count ?? 0
        for _ in 0..<180 {
            try? await Task.sleep(for: .milliseconds(16))
            low = min(low, scroll.contentOffset.y)
            high = max(high, scroll.contentOffset.y)
            samples += 1
        }
        let tenths = { (y: CGFloat) in Int((y * 10).rounded()) }
        TestHooks.recordDragHold(["held": tenths(held), "min": tenths(low), "max": tenths(high), "samples": samples,
                                  "pins": pins.ran - pinsBefore, "rowsLanded": (client.threads[sessionId]?.rows.count ?? 0) - rowsBefore,
                                  "atBottom": state.atBottom ? 1 : 0])
        // The finger lifts inside the slack: the reader is at the bottom again, and the next step pins.
        state.readerMoving = false
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

    /// An agent's session status wherever it lives: a wait whose body the
    /// host left behind reads its agents by this (`WaitSteps.resolved`).
    private var agentStatus: (String) -> String? {
        { [client, app] id in agentSession(id, home: client, registry: app.registry)?.session.status.rawValue }
    }

    /// What the rows read an agent's status through: the map `watchWaits`
    /// keeps, and the sessions themselves only for an agent it has not
    /// read yet (the first pass, a wait that just returned).
    private var waitStatus: (String) -> String? {
        { [waitRead, agentStatus] id in waitRead.status(id, unread: agentStatus) }
    }

    /// Keeps `waitRead` to the statuses of `ids` (the agents the omitted
    /// waits still need), read outside the body: it is written only when a
    /// named agent's status moves, so no other meta push re-runs the body.
    /// With no such agent nothing is read at all.
    private func watchWaits(_ ids: Set<String>) async {
        let status = agentStatus
        while !Task.isCancelled {
            let (changed, signal) = AsyncStream<Void>.makeStream()
            let next = ids.isEmpty ? WaitStatuses() : withObservationTracking {
                WaitStatuses.read(ids, statusOf: status)
            } onChange: {
                signal.yield()
                signal.finish()
            }
            if next != waitRead { waitRead = next }
            if ids.isEmpty { return }
            for await _ in changed { break }
        }
    }

    /// Pin on data changes, not on scroll geometry changes. Replacing the
    /// scroll view's size anchor at an edge forces a full layout pass, so
    /// the asks of one main-queue turn (each reveal step, each push, each
    /// change in the row count) coalesce into one pin on the next turn
    /// (`PinQueue`). Never while the reader's finger is down or the list
    /// still decelerates (`FollowRule`).
    private func pinTail(proxy: ScrollViewProxy) {
        func follows() -> Bool {
            FollowRule.write(for: .rowsChanged, atBottom: scrollState.atBottom, landing: targetStatus != nil,
                             reflowHeld: scrollState.reflowHeld, readerMoving: scrollState.readerMoving,
                             gliding: scrollState.glide.active(at: TranscriptView.now)) == .pin
        }
        guard follows(), pins.ask() else { return }
        Task { @MainActor in
            await Task.yield()
            pins.run(follows) {
                var transaction = Transaction()
                transaction.disablesAnimations = true
                TranscriptTrace.write("pinTail"); withTransaction(transaction) { proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom) }
            }
        }
    }

    /// A person's tap that resizes its row in place (a tool group opening
    /// or folding), the desktop's height glide: the row's height and the
    /// rows under it move on the layout spring in one transaction, nothing
    /// above moves, and a reader at the bottom is followed on that same
    /// spring (the scroll to the end rides the transaction). Pins and the
    /// bottom's verdict wait while it glides (`HandGlide`); its end asks for
    /// one pin. Reduced motion changes it at once and pins.
    private func handResize(proxy: ScrollViewProxy, _ change: () -> Void) {
        let write = FollowRule.write(for: .handResize, atBottom: scrollState.atBottom, landing: targetStatus != nil,
                                     reflowHeld: scrollState.reflowHeld, readerMoving: scrollState.readerMoving)
        if reduceMotion {
            Motion.withoutAnimation { change() }
            pinTail(proxy: proxy)
            return
        }
        scrollState.glide.begin(at: Self.now)
        TranscriptTrace.write("handResize")
        withAnimation(Motion.layout) {
            change()
            if write == .glide { proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom) }
        }
        let wait = scrollState.glide.remaining(at: Self.now)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(wait))
            guard !scrollState.glide.active(at: Self.now) else { return }
            pinTail(proxy: proxy)
        }
    }

    static var now: Double { Date().timeIntervalSinceReferenceDate }

    /// Opens on the asked row once it is in the loaded rows: the window
    /// widens to hold it, a group holding it is opened first (no animation),
    /// and the row lands centred.
    private func land(proxy: ScrollViewProxy) async {
        guard let targetSeq else { return }
        targetStatus = "Loading search result…"
        guard let seq = await client.reveal(sessionId, seq: targetSeq),
              let state = client.threads[sessionId],
              case let rows = TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen, memory: keyMemory, waits: state.fold.waitOutcomes, statusOf: waitStatus),
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
        let fills = listScroll.scroll.map { $0.contentSize.height > $0.bounds.height } ?? true
        let reach = SentinelReach.of(atBottom: scrollState.atBottom, readerMoving: scrollState.readerMoving, contentFills: fills)
        // At the bottom with nothing moving the list threw its offset: pin, and grow nothing above the reader.
        if reach == .pin {
            TranscriptTrace.write("sentinel pinned")
            pinTail(proxy: proxy)
            return
        }
        let deliberate = reach == .page
        // Where the reader is against the window's first row, before the page joins above it.
        let held = deliberate ? place(of: top.id) : nil
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
           let found = TranscriptRows.rowID(containing: anchorSeq, in: TranscriptRows.rows(state.entries, turnOpen: state.fold.board.turnOpen, memory: keyMemory, waits: state.fold.waitOutcomes, statusOf: waitStatus)) {
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
        if let held {
            await Task.yield()
            settle(anchor, at: held, rewrapped: false)
        }
    }
}

/// The list's scroll view, found once, and the reader's place a reflow
/// keeps; plain storage, outside observation.
@MainActor
final class ListScroll {
    weak var scroll: UIScrollView?
    var place: TranscriptReflow.Place?
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
    /// A person's tap resizing a row glides until this ends (`HandGlide`).
    @ObservationIgnored var glide = HandGlide()
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
