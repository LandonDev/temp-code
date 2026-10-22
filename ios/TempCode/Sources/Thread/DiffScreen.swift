import SwiftUI
import TempCodeClient
import TempCodeContract

/// An edit's diff, from a transcript edit row or a board Changes row. The
/// bytes come from the thread's own host: `client` is that host's client, so
/// a thread on the box reads from the box.
struct DiffRoute: Hashable {
    let sessionId: String
    let card: ChangeCard
}

/// A diff already in hand as the edit event's lines, with the host's own
/// counts: what a caller holding a `ToolPreview` opens.
struct LinesDiffRoute: Hashable {
    /// The path; shown in two steps.
    let title: String
    let lines: [ToolPreview.Line]
    let adds: Int
    let dels: Int
}

/// A unified patch (`diff --git`, `@@`), one file or many: the Inbox's pull
/// request. `file` keeps one file of a many-file patch.
struct PatchDiffRoute: Hashable {
    /// The file path, or the PR title for the whole patch.
    let title: String
    /// `GitHubPrDiff.patch`.
    let patch: String
    /// A `GitHubPrFile.path`; nil shows every file.
    var file: String? = nil
    /// The host's counts when known (`GitHubPrFile` / `GitHubPrDiff`); parsed otherwise.
    var adds: Int? = nil
    var dels: Int? = nil
}

/// The whole change to one file (or a patch across several), unified: mono
/// one step down, line numbers dim, adds and deletes tinted as on the
/// desktop, one sticky header per hunk, each hunk scrolling sideways on its
/// own under a pinned gutter. Lines the host kept are fetched when the
/// screen opens behind a shimmer of the height they will take.
struct DiffScreen: View {
    private enum Source: Hashable {
        case card(sessionId: String, card: ChangeCard)
        case lines(LinesDiffRoute)
        case patch(PatchDiffRoute)
    }

    private enum Phase: Equatable {
        case loading
        /// `partial`: an edit's lines are gone from the host; the rest shows.
        case ready(DiffDocument, partial: Bool)
        case empty
        case failed
    }

    /// What one `load()` answers to: the route, and the Retry count.
    private struct LoadKey: Equatable {
        let source: Source
        let attempt: Int
    }

    private let client: EnvironmentClient?
    private let source: Source
    @State private var phase: Phase
    @State private var attempt = 0
    @State private var current = 0
    @State private var position = ScrollPosition(edge: .top)
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(client: EnvironmentClient, route: DiffRoute) {
        self.client = client
        let source = Source.card(sessionId: route.sessionId, card: route.card)
        self.source = source
        _phase = State(initialValue: Self.parsed(source) ?? .loading)
    }

    init(route: LinesDiffRoute) {
        client = nil
        source = .lines(route)
        _phase = State(initialValue: Self.parsed(.lines(route)) ?? .loading)
    }

    init(route: PatchDiffRoute) {
        client = nil
        source = .patch(route)
        _phase = State(initialValue: Self.parsed(.patch(route)) ?? .loading)
    }

    var body: some View {
        let metrics = DiffMetrics(size: typeSize)
        ZStack(alignment: .top) {
            switch phase {
            case .loading:
                DiffShimmer(rows: estimate.rows, headers: estimate.headers, metrics: metrics)
                    .transition(.opacity)
            case .ready(let document, let partial):
                VStack(spacing: 0) {
                    if partial {
                        DiffNotice(text: "Part of this diff is gone from the host.", error: true) { reload() }
                            .background(Surface.chrome)
                    }
                    DiffBody(document: document, metrics: metrics, current: $current, position: $position)
                }
                .transition(.opacity)
            case .empty:
                DiffNotice(text: emptyText, error: false)
                    .transition(.opacity)
            case .failed:
                DiffNotice(text: "The diff is gone from the host.", error: true) { reload() }
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Surface.background)
        // The bar draws the principal item; the title is for the back
        // button's history and the screen's accessibility name.
        .navigationTitle(Board.fileName(titlePath))
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
            if hunkCount > 1 {
                ToolbarItemGroup(placement: .bottomBar) {
                    Button {
                        go(to: current - 1)
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
                        go(to: current + 1)
                    } label: {
                        Image(systemName: "chevron.down")
                    }
                    .disabled(current >= hunkCount - 1)
                    .accessibilityLabel("Next hunk")
                }
            }
        }
        .task(id: LoadKey(source: source, attempt: attempt)) { await load() }
    }

    // MARK: - what the chrome shows

    private var titlePath: String {
        switch source {
        case .card(_, let card): card.path
        case .lines(let route): route.title
        case .patch(let route): route.title
        }
    }

    /// The host's own count when the route carries one (an edit's preview
    /// may hold fewer lines than the change); the parsed count otherwise.
    private var stat: (adds: Int, dels: Int) {
        switch source {
        case .card(_, let card): return (card.adds, card.dels)
        case .lines(let route): return (route.adds, route.dels)
        case .patch(let route):
            if let adds = route.adds, let dels = route.dels { return (adds, dels) }
            if case .ready(let document, _) = phase { return (document.adds, document.dels) }
            return (0, 0)
        }
    }

    private var emptyText: String {
        if case .patch = source { "No changes to show." } else { "This edit left no lines to show." }
    }

    private var document: DiffDocument? {
        if case .ready(let document, _) = phase { document } else { nil }
    }

    private var hunkCount: Int { document?.hunks.count ?? 0 }

    /// What the diff will take while its lines load: the rows each edit
    /// carries or the count the host left with an omitted body, and one
    /// header per edit that has lines (each starts a hunk).
    private var estimate: (rows: Int, headers: Int) {
        guard case .card(_, let card) = source else { return (8, 1) }
        var rows = 0
        var headers = 0
        for edit in card.edits {
            switch edit.preview?.lines {
            case .array(let lines)?: rows += lines.count
            case .omittedBody(let omitted)?: rows += omitted.lines
            default: continue
            }
            headers += 1
        }
        return (max(rows, 4), max(headers, 1))
    }

    /// Previous or next hunk: the header's exact `y` from the fixed heights,
    /// so the jump lands where the position indicator says it will.
    private func go(to index: Int) {
        guard let document, !document.hunks.isEmpty else { return }
        let target = min(max(index, 0), document.hunks.count - 1)
        let starts = DiffMetrics(size: typeSize).layout.hunkStarts(document)
        current = target
        if reduceMotion {
            position.scrollTo(y: starts[target])
        } else {
            withAnimation(.timingCurve(0.23, 1, 0.32, 1, duration: 0.25)) { position.scrollTo(y: starts[target]) }
        }
    }

    // MARK: - loading

    /// The last route parsed and its phase. A pushed screen is built again
    /// on every render of the screen beneath it, and `init` runs each time;
    /// one entry keeps a 3,600-line patch from parsing on every token the
    /// transcript streams. Main-actor state, as the view is.
    private static var lastParsed: (source: Source, phase: Phase)?

    /// A route whose lines are already in hand (a patch, lines, or a card
    /// every edit of which carries its lines) parses before the first
    /// frame: no shimmer, no fetch. nil when something must be fetched.
    private static func parsed(_ source: Source) -> Phase? {
        if let lastParsed, lastParsed.source == source { return lastParsed.phase }
        let document: DiffDocument
        switch source {
        case .card(_, let card):
            guard card.lines != nil else { return nil }
            document = DiffDocument.from(edits: card.edits.compactMap { edit -> [ToolPreview.Line]? in
                guard case .array(let lines)? = edit.preview?.lines else { return nil }
                return lines
            })
        case .lines(let route): document = DiffDocument.from(edits: [route.lines])
        case .patch(let route): document = DiffDocument.from(patch: route.patch, file: route.file)
        }
        let phase: Phase = document.isEmpty ? .empty : .ready(document, partial: false)
        lastParsed = (source, phase)
        return phase
    }

    /// Retry: back to the shimmer and the top, and a new load through the
    /// same task, so leaving the screen cancels it and two taps run once.
    private func reload() {
        phase = .loading
        current = 0
        position = ScrollPosition(edge: .top)
        attempt += 1
    }

    private func load() async {
        if let parsed = Self.parsed(source) {
            settle(parsed)
            return
        }
        guard case .card(let sessionId, let card) = source, let client else {
            settle(.failed)
            return
        }
        var edits: [[ToolPreview.Line]] = []
        var lost = false
        for edit in card.edits {
            if case .array(let held)? = edit.preview?.lines {
                edits.append(held)
                continue
            }
            guard case .omittedBody? = edit.preview?.lines else { continue }
            let row = await client.body(sessionId: sessionId, seq: edit.seq)
            if Task.isCancelled { return }
            if let row,
               case .toolCall(let call) = row.event,
               case .array(let fetched)? = call.preview?.lines {
                edits.append(fetched)
            } else {
                lost = true
            }
        }
        let document = DiffDocument.from(edits: edits)
        if Task.isCancelled { return }
        settle(document.isEmpty ? (lost ? .failed : .empty) : .ready(document, partial: lost))
    }

    private func settle(_ next: Phase) {
        guard next != phase else { return }
        if reduceMotion {
            phase = next
        } else {
            withAnimation(Motion.crossFade) { phase = next }
        }
    }
}

// MARK: - chrome

/// The file path in two steps on one line: the directory dim, the name in
/// the title's own color; the head truncates so the name always shows. A
/// long press copies the whole path.
private struct DiffTitle: View {
    let path: String

    var body: some View {
        let name = Board.fileName(path)
        let directory = String(path.dropLast(name.count))
        Text("\(Text(directory).foregroundStyle(.tertiary))\(name)")
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            .truncationMode(.head)
            .accessibilityLabel(path)
            .contextMenu {
                Button("Copy path", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = path
                }
            }
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
/// of the estimated height (the rows, and a header for every hunk after
/// the first), capped at a screen and a half.
private struct DiffShimmer: View {
    let rows: Int
    let headers: Int
    let metrics: DiffMetrics

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: metrics.headerHeight)
            Shimmer(height: min(CGFloat(rows) * metrics.rowHeight + CGFloat(headers - 1) * metrics.headerHeight, 1_200))
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
    @Binding var position: ScrollPosition
    @State private var offsets: [Int: CGFloat] = [:]
    @State private var drag: DragState?
    /// True while a finger is on a row's sideways gesture; SwiftUI resets
    /// it when the gesture ends or is cancelled, which `onEnded` never sees.
    @GestureState private var touching = false
    /// True while previous or next hunk animates the scroll: the geometry
    /// passes every hunk between, and the counter already says the target.
    @State private var jumping = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// One sideways gesture from its first change to its release. The scroll
    /// view takes a vertical start and cancels the gesture without an end,
    /// so a change whose start location differs is a new gesture.
    private struct DragState {
        let hunk: Int
        let startLocation: CGPoint
        let from: CGFloat
        let reach: CGFloat
        let horizontal: Bool
    }

    var body: some View {
        let gutter = metrics.gutterWidth(digits: document.digits)
        let numberWidth = metrics.numberWidth(digits: document.digits)
        let layout = metrics.layout
        let starts = layout.hunkStarts(document)
        GeometryReader { geometry in
            let textWidth = max(80, geometry.size.width - gutter)
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: .sectionHeaders) {
                    ForEach(document.hunks) { hunk in
                        Section {
                            let overflow = reach(of: hunk, textWidth: textWidth)
                            let stored = offsets[hunk.id] ?? 0
                            let offset = drag?.hunk == hunk.id ? stored : min(max(stored, 0), max(overflow, 0))
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
                        }
                    }
                    // Room for the last header to reach the top when the
                    // column is taller than the screen, so next hunk always lands.
                    Color.clear.frame(height: footer(layout: layout, starts: starts, viewport: geometry.size.height))
                }
            }
            .scrollPosition($position, anchor: .top)
            .scrollBounceBehavior(.basedOnSize)
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { _, y in
                guard !jumping else { return }
                let index = layout.hunkIndex(at: y, starts: starts)
                if index != current { current = index }
            }
            .onScrollPhaseChange { _, phase, context in
                jumping = phase == .animating
                guard phase == .idle else { return }
                let geometry = context.geometry
                let index = layout.hunkIndex(at: geometry.contentOffset.y + geometry.contentInsets.top, starts: starts)
                if index != current { current = index }
            }
            .onChange(of: touching) { _, now in
                guard !now else { return }
                // After `onEnded` has had its turn: a gesture the system
                // cancelled never gets one, and its hunk would stay stretched.
                Task { @MainActor in settleCancelled() }
            }
        }
    }

    /// A drag that ended without `onEnded`: back inside the hunk's reach,
    /// from wherever the finger left it, with the shortest settle.
    private func settleCancelled() {
        guard let state = drag else { return }
        drag = nil
        guard state.horizontal else { return }
        let target = min(max(0, offsets[state.hunk] ?? 0), max(state.reach, 0))
        if reduceMotion {
            offsets[state.hunk] = target
        } else {
            withAnimation(Self.settle(travel: 0)) { offsets[state.hunk] = target }
        }
    }

    private func footer(layout: DiffLayout, starts: [CGFloat], viewport: CGFloat) -> CGFloat {
        guard let last = document.hunks.last, let start = starts.last else { return 24 }
        let lastHeight = layout.height(last)
        guard start + lastHeight > viewport else { return 24 }
        return max(24, viewport - lastHeight)
    }

    /// How far the hunk's widest line runs past the text column, with 12 pt
    /// of air after it.
    private func reach(of hunk: DiffHunk, textWidth: CGFloat) -> CGFloat {
        CGFloat(hunk.widestChars) * metrics.charWidth + 12 - textWidth
    }

    /// The first change decides: the larger component is the gesture's axis
    /// for its life, and a vertical start is left to the scroll view. While
    /// the finger moves the offset follows it through an interactive spring,
    /// so a hunk caught mid-settle blends to the finger instead of jumping.
    /// The release projects the throw, clamps it to the hunk's reach and
    /// settles with no bounce in a time that follows the travel.
    private func sideways(hunk: DiffHunk, reach: CGFloat, width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .local)
            .updating($touching) { _, touching, _ in touching = true }
            .onChanged { value in
                if drag == nil || drag?.startLocation != value.startLocation {
                    let t = value.translation
                    drag = DragState(hunk: hunk.id, startLocation: value.startLocation, from: offsets[hunk.id] ?? 0, reach: reach, horizontal: abs(t.width) > abs(t.height))
                }
                guard let drag, drag.horizontal, drag.hunk == hunk.id else { return }
                let x = Self.rubber(drag.from - value.translation.width, reach: reach, width: width)
                if reduceMotion {
                    offsets[hunk.id] = x
                } else {
                    withAnimation(.interactiveSpring(response: 0.15, dampingFraction: 0.86, blendDuration: 0.25)) { offsets[hunk.id] = x }
                }
            }
            .onEnded { value in
                guard let state = drag else { return }
                drag = nil
                guard state.horizontal, state.hunk == hunk.id else { return }
                let projected = state.from - value.predictedEndTranslation.width
                let target = min(max(0, projected), reach)
                if reduceMotion {
                    offsets[hunk.id] = target
                } else {
                    let travel = abs(target - (offsets[hunk.id] ?? 0))
                    withAnimation(Self.settle(travel: travel)) { offsets[hunk.id] = target }
                }
            }
    }

    /// The settle after a release: no bounce, 0.35 s plus 0.4 ms per point
    /// of travel, never past 0.6 s, so a long flick glides and a nudge stops.
    static func settle(travel: CGFloat) -> Animation {
        .spring(duration: min(0.6, 0.35 + travel * 0.0004), bounce: 0)
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
        // A shape, not a bare Color: a Color background inside a scroll
        // container takes the container's corner rounding on iOS 26.
        .background {
            if let color {
                Rectangle().fill(color.opacity(DiffPalette.tint))
            }
        }
        .overlay(alignment: .leading) {
            if let color {
                Rectangle().fill(color).frame(width: DiffPalette.bar)
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
