import SwiftUI
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
    @State private var atBottom = true
    @State private var landedOnTarget = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Rows a cold open shows, and one page back.
    static let page = 75

    var body: some View {
        let entries = thread.fold.items
        let shown = entries.count > window ? Array(entries.suffix(window)) : entries
        let moreAbove = entries.count > window || thread.moreBefore
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if moreAbove {
                        TopSentinel(loading: thread.isLoadingOlder) {
                            await extend(proxy: proxy, entries: entries, shown: shown)
                        }
                    } else if entries.isEmpty {
                        EmptyTranscript(thread: thread)
                    }
                    ForEach(shown) { entry in
                        TranscriptRow(entry: entry, client: client, sessionId: sessionId)
                            .id(entry.id)
                            .accessibilityIdentifier("transcript-item")
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(TranscriptAnchor.bottom)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            .defaultScrollAnchor(.bottom)
            .defaultScrollAnchor(.bottom, for: .sizeChanges)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                // Content shorter than the screen is "at the bottom" too.
                geometry.contentSize.height <= geometry.containerSize.height || geometry.visibleRect.maxY >= geometry.contentSize.height - 64
            } action: { _, now in
                atBottom = now
            }
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y } action: { _, y in
                recorder?.noteOffset(y)
            }
            .overlay(alignment: .bottom) {
                if !atBottom {
                    JumpPill {
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom) }
                    }
                    .padding(.bottom, 12)
                    .transition(Motion.appear(reduced: reduceMotion))
                }
            }
            .animation(Motion.crossFade, value: atBottom)
            .onAppear { land(proxy: proxy, entries: entries) }
            .onChange(of: entries.count) { land(proxy: proxy, entries: entries) }
            .task(id: thread.isLoading) {
                guard TestHooks.scroll, !thread.isLoading, !entries.isEmpty, !scrollRan else { return }
                scrollRan = true
                await scrollProof(proxy: proxy, entries: entries)
            }
        }
    }

    @State private var scrollRan = false
    @State private var recorder: FrameRecorder?

    /// Every row in the window, then a 25 s glide to the top and back while
    /// the frames are recorded.
    private func scrollProof(proxy: ScrollViewProxy, entries: [ThreadEntry]) async {
        window = entries.count
        try? await Task.sleep(for: .seconds(2))
        let recorder = FrameRecorder()
        self.recorder = recorder
        recorder.start()
        withAnimation(.linear(duration: 25)) { proxy.scrollTo(entries[0].id, anchor: .top) }
        try? await Task.sleep(for: .seconds(26))
        withAnimation(.linear(duration: 25)) { proxy.scrollTo(TranscriptAnchor.bottom, anchor: .bottom) }
        try? await Task.sleep(for: .seconds(26))
        _ = recorder.stop()
        self.recorder = nil
    }

    /// Opens on the asked row once it is in the loaded rows: the window
    /// widens to hold it and the row lands centred.
    private func land(proxy: ScrollViewProxy, entries: [ThreadEntry]) {
        guard !landedOnTarget, let targetSeq, let index = entries.firstIndex(where: { $0.seq >= targetSeq }) else { return }
        landedOnTarget = true
        let needed = entries.count - index + 8
        if needed > window { window = needed }
        let id = entries[index].id
        Task {
            try? await Task.sleep(for: .milliseconds(60))
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { proxy.scrollTo(id, anchor: .center) }
        }
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
