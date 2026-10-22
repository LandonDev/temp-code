import SwiftUI
import UIKit
import Observation
import TempCodeClient
import TempCodeContract

/// The transcript: the newest 75 rows, one page more each time the top is
/// reached, pinned to the bottom while the user is there, a "Jump to
/// latest" pill once they scroll up. Rows keep their identity by seq, so a
/// streaming row updates its own text and nothing above it moves.
struct TranscriptView: View {
    let client: EnvironmentClient
    let sessionId: String
    let thread: ThreadState
    var targetSeq: Int?
    @State private var window = TranscriptView.page
    @State private var scrollState = TranscriptScrollState()
    @State private var targetStatus: String?

    /// Rows a cold open shows, and one page back.
    static let page = 75

    var body: some View {
        let entries = thread.entries
        let shown = entries.count > window ? Array(entries.suffix(window)) : entries
        let moreAbove = entries.count > window || thread.moreBefore
        ScrollViewReader { proxy in
            List {
                if moreAbove {
                    TopSentinel(loading: thread.isLoadingOlder) {
                        await extend(proxy: proxy, entries: entries, shown: shown)
                    }
                    .listRowInsets(rowInsets)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                } else if entries.isEmpty {
                    EmptyTranscript(thread: thread)
                        .listRowInsets(rowInsets)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                ForEach(shown) { entry in
                    VStack(alignment: .leading, spacing: 0) {
                        TranscriptRow(entry: entry, client: client, sessionId: sessionId)
                            .equatable()
                    }
                    .id(entry.id)
                    .accessibilityIdentifier("transcript-item")
                    // Return flow (thread 14): the row at the top while scrolled up is the anchor a relaunch lands on.
                    .onScrollVisibilityChange(threshold: 0.5) { visible in if visible, !scrollState.atBottom { ScrollMemory.set(entry.id, for: sessionId) } }
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
            .contentMargins(.vertical, 6, for: .scrollContent)
            .navigationLinkIndicatorVisibility(.hidden)
            .buttonStyle(.plain)
            .scrollBounceBehavior(.basedOnSize)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .defaultScrollAnchor(.bottom, for: .alignment)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                // Content shorter than the screen is "at the bottom" too.
                geometry.contentSize.height <= geometry.containerSize.height || geometry.visibleRect.maxY >= geometry.contentSize.height - 64
            } action: { _, now in
                scrollState.atBottom = now
                if now { ScrollMemory.set(nil, for: sessionId) }
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
            .onChange(of: entries.count, initial: true) {
                if !entries.isEmpty, !initializedScroll, targetSeq == nil {
                    initializedScroll = true
                    Task { @MainActor in
                        await Task.yield()
                        // Return flow (thread 14): a relaunch lands on the remembered row, with no motion.
                        if let anchor = ScrollMemory.anchor(for: sessionId), entries.contains(where: { $0.id == anchor }) {
                            var transaction = Transaction()
                            transaction.disablesAnimations = true
                            withTransaction(transaction) { proxy.scrollTo(anchor, anchor: .top) }
                        } else {
                            proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom)
                        }
                    }
                } else { pinTail(proxy: proxy) }
            }
            .task(id: thread.isLoading) {
                guard !thread.isLoading, client.threads[sessionId] != nil else { return }
                await land(proxy: proxy)
            }
            .task(id: thread.isLoading) {
                guard TestHooks.scroll, !thread.isLoading, !entries.isEmpty, !scrollRan else { return }
                scrollRan = true
                await scrollProof(proxy: proxy)
            }
        }
    }

    private var rowInsets: EdgeInsets { EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16) }

    @State private var initializedScroll = false
    @State private var proofScrollView: UIScrollView?
    @State private var scrollRan = false
    @State private var recorder: FrameRecorder?

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
        let entries = state.entries
        window = entries.count
        try? await Task.sleep(for: .seconds(2))
        var setup = Transaction()
        setup.disablesAnimations = true
        withTransaction(setup) { proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom) }
        try? await Task.sleep(for: .seconds(2))
        guard let proofScrollView else { return }
        let recorder = FrameRecorder()
        self.recorder = recorder
        recorder.start(sourceRows: state.rows.count, items: entries.count, scrollView: proofScrollView)
        // List uses UIKit's fixed-duration scrollTo animation. Drive its
        // native offset continuously for two measured 25-second glides.
        try? await Task.sleep(for: .seconds(52))
        _ = recorder.stop()
        self.recorder = nil
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
    /// widens to hold it and the row lands centred.
    private func land(proxy: ScrollViewProxy) async {
        guard let targetSeq else { return }
        targetStatus = "Loading search result…"
        guard let id = await client.reveal(sessionId, seq: targetSeq),
              let entries = client.threads[sessionId]?.entries,
              let index = entries.firstIndex(where: { $0.id == id }) else {
            if !Task.isCancelled {
                targetStatus = "Search result could not be found."
                TestHooks.recordNavigation(target: targetSeq, item: nil, oldest: client.threads[sessionId]?.rows.first?.seq)
            }
            return
        }
        guard !Task.isCancelled else { return }
        targetStatus = nil
        TestHooks.recordNavigation(target: targetSeq, item: id, oldest: client.threads[sessionId]?.rows.first?.seq)
        window = max(window, entries.count - index + 8)
        try? await Task.sleep(for: .milliseconds(60))
        guard !Task.isCancelled else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { proxy.scrollTo(id, anchor: .center) }
    }

    /// One page back: rows already held, then older ones from the cache or
    /// the host. The row that was at the top stays where it is.
    private func extend(proxy: ScrollViewProxy, entries: [ThreadEntry], shown: [ThreadEntry]) async {
        let anchor = shown.first?.id
        if entries.count > window {
            window += Self.page
        } else {
            await client.loadOlder(sessionId)
            window += olderPage
        }
        guard let anchor else { return }
        try? await Task.sleep(for: .milliseconds(16))
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { proxy.scrollTo(anchor, anchor: .top) }
    }
}

@MainActor @Observable
private final class TranscriptScrollState {
    var atBottom = true
}

/// Only this control reads the position flag. Reaching an edge must not
/// rebuild the scroll view and its lazy layout.
private struct TranscriptScrollControls: View {
    let state: TranscriptScrollState
    let jump: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        JumpPill(jump: jump)
            .padding(.bottom, 12)
            .opacity(state.atBottom ? 0 : 1)
            .offset(y: state.atBottom && !reduceMotion ? 8 : 0)
            .allowsHitTesting(!state.atBottom)
            .accessibilityHidden(state.atBottom)
            .animation(Motion.crossFade, value: state.atBottom)
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
                Text("Nothing here yet")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.top, 40)
    }
}

/// The one floating control in the transcript: raised, with a shadow, over the rows.
private struct JumpPill: View {
    let jump: () -> Void
    @Environment(\.displayScale) private var scale

    var body: some View {
        Button(action: jump) {
            Label("Jump to latest", systemImage: "arrow.down")
                .font(.footnote.weight(.medium))
                .labelStyle(.titleAndIcon)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Surface.raised, in: Capsule())
                .overlay(Capsule().strokeBorder(Surface.hairline, lineWidth: 1 / scale))
                .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
        }
        .buttonStyle(.pressable)
    }
}
