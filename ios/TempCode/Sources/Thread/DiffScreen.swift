import SwiftUI
import TempCodeClient
import TempCodeContract

/// An edit's diff, from a transcript edit row or a board Changes row.
struct DiffRoute: Hashable {
    let sessionId: String
    let card: ChangeCard
}

/// A unified patch opened from elsewhere: the Inbox's pull request detail.
struct PatchDiffRoute: Hashable {
    let title: String
    let patch: String
}

/// The whole change to one file (or a patch across several), unified: mono
/// one step down, line numbers dim, adds and deletes tinted as on the
/// desktop, one sticky header per hunk, each hunk scrolling sideways on its
/// own under a pinned gutter. Lines the host kept are fetched when the
/// screen opens behind a shimmer of the height they will take.
struct DiffScreen: View {
    enum Source: Hashable {
        case card(sessionId: String, card: ChangeCard)
        case patch(title: String, patch: String)
    }

    private enum Phase: Equatable {
        case loading
        case ready(DiffDocument)
        case empty
        case failed
    }

    let client: EnvironmentClient?
    let source: Source
    @State private var phase: Phase = .loading
    @State private var current = 0
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(client: EnvironmentClient, route: DiffRoute) {
        self.client = client
        source = .card(sessionId: route.sessionId, card: route.card)
    }

    init(route: PatchDiffRoute) {
        client = nil
        source = .patch(title: route.title, patch: route.patch)
    }

    var body: some View {
        let metrics = DiffMetrics(size: typeSize)
        ScrollViewReader { proxy in
            ZStack(alignment: .top) {
                switch phase {
                case .loading:
                    DiffShimmer(rows: estimatedRows, metrics: metrics)
                        .transition(.opacity)
                case .ready(let document):
                    DiffBody(document: document, metrics: metrics, current: $current)
                        .transition(.opacity)
                case .empty:
                    DiffNotice(text: "This edit left no lines to show.", error: false)
                        .transition(.opacity)
                case .failed:
                    DiffNotice(text: "The diff is gone from the host.", error: true) {
                        phase = .loading
                        Task { await load() }
                    }
                    .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .toolbar {
                if hunkCount > 1 {
                    ToolbarItemGroup(placement: .bottomBar) {
                        Button {
                            go(to: current - 1, proxy: proxy)
                        } label: {
                            Image(systemName: "chevron.up")
                        }
                        .disabled(current <= 0)
                        .accessibilityLabel("Previous hunk")
                        Spacer()
                        Text("\(current + 1) of \(hunkCount)")
                            .font(.footnote)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                            .contentTransition(.numericText())
                            .animation(reduceMotion ? nil : Motion.crossFade, value: current)
                            .accessibilityLabel("Hunk \(current + 1) of \(hunkCount)")
                        Spacer()
                        Button {
                            go(to: current + 1, proxy: proxy)
                        } label: {
                            Image(systemName: "chevron.down")
                        }
                        .disabled(current >= hunkCount - 1)
                        .accessibilityLabel("Next hunk")
                    }
                }
            }
        }
        .background(Surface.background)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Surface.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarBackground(.visible, for: .bottomBar)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                DiffTitle(path: titlePath)
            }
            ToolbarItem(placement: .topBarTrailing) {
                ChangeStat(adds: stat.adds, dels: stat.dels)
            }
        }
        .task(id: source) { await load() }
    }

    // MARK: - what the chrome shows

    private var titlePath: String {
        switch source {
        case .card(_, let card): card.path
        case .patch(let title, _): title
        }
    }

    /// The host's own count for an edit (its preview may hold fewer lines
    /// than the change); the parsed count for a patch.
    private var stat: (adds: Int, dels: Int) {
        switch source {
        case .card(_, let card): (card.adds, card.dels)
        case .patch:
            if case .ready(let document) = phase { (document.adds, document.dels) } else { (0, 0) }
        }
    }

    private var hunkCount: Int {
        if case .ready(let document) = phase { document.hunks.count } else { 0 }
    }

    /// Rows the diff will take, from the lines each edit carries or the
    /// count the host left behind with an omitted body.
    private var estimatedRows: Int {
        guard case .card(_, let card) = source else { return 8 }
        var rows = 0
        for edit in card.edits {
            switch edit.preview?.lines {
            case .array(let lines)?: rows += lines.count
            case .omittedBody(let omitted)?: rows += omitted.lines
            default: rows += 8
            }
        }
        return max(rows, 4)
    }

    private func go(to index: Int, proxy: ScrollViewProxy) {
        let target = min(max(index, 0), hunkCount - 1)
        current = target
        if reduceMotion {
            proxy.scrollTo(DiffAnchor.hunk(target), anchor: .top)
        } else {
            withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(DiffAnchor.hunk(target), anchor: .top) }
        }
    }

    // MARK: - loading

    private func load() async {
        switch source {
        case .patch(_, let patch):
            let document = DiffDocument.from(patch: patch)
            settle(document.isEmpty ? .empty : .ready(document))
        case .card(let sessionId, let card):
            guard let client else { settle(.failed); return }
            var edits: [[ToolPreview.Line]] = []
            var lost = false
            for edit in card.edits {
                if case .array(let held)? = edit.preview?.lines {
                    edits.append(held)
                    continue
                }
                guard case .omittedBody? = edit.preview?.lines else { continue }
                if let row = await client.body(sessionId: sessionId, seq: edit.seq),
                   case .toolCall(let call) = row.event,
                   case .array(let fetched)? = call.preview?.lines {
                    edits.append(fetched)
                } else {
                    lost = true
                }
            }
            let document = DiffDocument.from(edits: edits)
            settle(document.isEmpty ? (lost ? .failed : .empty) : .ready(document))
        }
    }

    private func settle(_ next: Phase) {
        if reduceMotion {
            phase = next
        } else {
            withAnimation(Motion.crossFade) { phase = next }
        }
    }
}

/// Scroll targets inside the diff: one per hunk header.
private enum DiffAnchor: Hashable {
    case hunk(Int)
}

// MARK: - chrome

/// The file path in two steps on one line: the directory dim, the name in
/// the title's own color; the head truncates so the name always shows.
private struct DiffTitle: View {
    let path: String

    var body: some View {
        let name = Board.fileName(path)
        let directory = String(path.dropLast(name.count))
        (Text(directory).foregroundStyle(.tertiary) + Text(name))
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .truncationMode(.head)
            .accessibilityLabel(path)
    }
}

/// One quiet line at the top of the screen: the edit left nothing, or the
/// host no longer has it (with Retry).
private struct DiffNotice: View {
    let text: String
    let error: Bool
    var retry: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: error ? "exclamationmark.triangle" : "doc.text")
                .font(.footnote)
                .frame(width: 16)
            Text(text)
                .font(.footnote)
            Spacer(minLength: 8)
            if let retry {
                PillButton("Retry", action: retry)
            }
        }
        .foregroundStyle(error ? Tint.destructive : Color(.secondaryLabel))
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// The shimmer of the rows about to land: a header's slot, then one block
/// of the estimated height, capped at a screen and a half.
private struct DiffShimmer: View {
    let rows: Int
    let metrics: DiffMetrics

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: metrics.headerHeight)
            Shimmer(height: min(CGFloat(rows) * metrics.rowHeight, 1_200))
                .padding(.horizontal, 16)
                .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - the body

/// The hunks as pinned sections of one lazy column. Each hunk owns a
/// horizontal offset: a sideways drag on any of its rows moves the whole
/// hunk's text under the pinned gutter, with the finger's momentum and a
/// rubber band at both ends; a hunk that fits never moves.
private struct DiffBody: View {
    let document: DiffDocument
    let metrics: DiffMetrics
    @Binding var current: Int
    @State private var offsets: [Int: CGFloat] = [:]
    @State private var drag: DragState?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct DragState {
        let hunk: Int
        let start: CGFloat
        let horizontal: Bool
    }

    var body: some View {
        let gutter = metrics.gutterWidth(digits: document.digits)
        let numberWidth = metrics.numberWidth(digits: document.digits)
        let starts = metrics.hunkStarts(document)
        GeometryReader { geometry in
            let textWidth = max(80, geometry.size.width - gutter)
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: .sectionHeaders) {
                    ForEach(document.hunks) { hunk in
                        Section {
                            let overflow = reach(of: hunk, textWidth: textWidth)
                            let offset = min(offsets[hunk.id] ?? 0, max(overflow, 0))
                            ForEach(hunk.lines) { line in
                                DiffLineRow(line: line, metrics: metrics, numberWidth: numberWidth, textWidth: textWidth, offset: offset)
                                    .equatable()
                                    .contextMenu {
                                        Button("Copy line", systemImage: "doc.on.doc") {
                                            UIPasteboard.general.string = line.text
                                        }
                                        Button("Copy hunk", systemImage: "doc.on.doc.fill") {
                                            UIPasteboard.general.string = hunk.unified
                                        }
                                    }
                                    .gesture(sideways(hunk: hunk, reach: overflow, width: textWidth), including: overflow > 0 ? .all : .subviews)
                            }
                        } header: {
                            DiffHunkHeader(hunk: hunk, showFile: document.multiFile, height: metrics.headerHeight)
                                .id(DiffAnchor.hunk(hunk.id))
                        }
                    }
                    Color.clear.frame(height: 24)
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { _, y in
                let index = metrics.hunkIndex(at: y, starts: starts)
                if index != current { current = index }
            }
        }
    }

    /// How far the hunk's widest line runs past the text column, with 12 pt
    /// of air after it.
    private func reach(of hunk: DiffHunk, textWidth: CGFloat) -> CGFloat {
        CGFloat(hunk.widestChars) * metrics.charWidth + 12 - textWidth
    }

    private func sideways(hunk: DiffHunk, reach: CGFloat, width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .local)
            .onChanged { value in
                if drag == nil {
                    let t = value.translation
                    drag = DragState(hunk: hunk.id, start: offsets[hunk.id] ?? 0, horizontal: abs(t.width) > abs(t.height))
                }
                guard let drag, drag.horizontal, drag.hunk == hunk.id else { return }
                offsets[hunk.id] = Self.rubber(drag.start - value.translation.width, reach: reach, width: width)
            }
            .onEnded { value in
                guard let state = drag else { return }
                drag = nil
                guard state.horizontal, state.hunk == hunk.id else { return }
                let projected = state.start - value.predictedEndTranslation.width
                let target = min(max(0, projected), reach)
                if reduceMotion {
                    offsets[hunk.id] = target
                } else {
                    withAnimation(Motion.expand) { offsets[hunk.id] = target }
                }
            }
    }

    /// Past either end the text follows the finger less and less: Apple's
    /// rubber band, `d·c·w / (d·c + w)` with c = 0.55 over the column width.
    private static func rubber(_ x: CGFloat, reach: CGFloat, width: CGFloat) -> CGFloat {
        func band(_ d: CGFloat) -> CGFloat { d * 0.55 * width / (d * 0.55 + width) }
        if x < 0 { return -band(-x) }
        if x > reach { return reach + band(x - reach) }
        return x
    }
}

/// A hunk's sticky row on the one gray step: the file when the document
/// spans several, the line range, `+n −m` for the hunk.
private struct DiffHunkHeader: View {
    let hunk: DiffHunk
    let showFile: Bool
    let height: CGFloat

    var body: some View {
        HStack(spacing: 6) {
            if showFile, let file = hunk.file {
                Text(Board.fileName(file))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("·")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
            Text(hunk.range)
                .font(.footnote.weight(showFile ? .regular : .semibold))
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .lineLimit(1)
            Spacer(minLength: 8)
            ChangeStat(adds: hunk.adds, dels: hunk.dels)
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: height)
        .background(Surface.chrome)
        .overlay(alignment: .bottom) { Hairline() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(hunk.accessibilityLabel)
        .accessibilityAddTraits(.isHeader)
    }
}

/// One line: the number dim and right-aligned, the sign bold in the line's
/// color, then the text in the pinned-gutter column, clipped and shifted by
/// the hunk's offset. The tint sits behind the whole row with a 2 pt bar on
/// the leading edge, as on the desktop.
private struct DiffLineRow: View, Equatable {
    let line: DiffLine
    let metrics: DiffMetrics
    let numberWidth: CGFloat
    let textWidth: CGFloat
    let offset: CGFloat

    var body: some View {
        let color = DiffPalette.color(line.kind)
        HStack(spacing: 0) {
            Text(line.number.map { String($0) } ?? "")
                .foregroundStyle(.tertiary)
                .frame(width: numberWidth, alignment: .trailing)
                .padding(.leading, 8)
            Text(DiffPalette.sign(line.kind))
                .fontWeight(.bold)
                .foregroundStyle(color ?? .clear)
                .frame(width: metrics.charWidth + 12)
            Text(line.text)
                .foregroundStyle(.primary)
                .opacity(line.kind == .context ? DiffPalette.contextOpacity : 1)
                .fixedSize(horizontal: true, vertical: false)
                .offset(x: -offset)
                .frame(width: textWidth, alignment: .leading)
                .clipped()
        }
        .font(.system(.footnote, design: .monospaced))
        .lineLimit(1)
        .frame(height: metrics.rowHeight)
        .background(color?.opacity(DiffPalette.tint) ?? .clear)
        .overlay(alignment: .leading) {
            if let color {
                color.frame(width: DiffPalette.bar)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        let what = switch line.kind {
        case .add: "Added"
        case .del: "Removed"
        case .context: "Line"
        }
        let number = line.number.map { " \($0)" } ?? ""
        return "\(what)\(number): \(line.text.isEmpty ? "blank" : line.text)"
    }

    static func == (a: DiffLineRow, b: DiffLineRow) -> Bool {
        a.line == b.line && a.metrics == b.metrics && a.numberWidth == b.numberWidth && a.textWidth == b.textWidth && a.offset == b.offset
    }
}
