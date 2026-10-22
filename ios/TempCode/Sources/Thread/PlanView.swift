import SwiftUI
import TempCodeClient

/// The plan file as the page: a set document at body size, streaming in as
/// the agent writes it. The last text seen paints at once from the plan
/// cache; a plan with no content yet is one quiet line, never a spinner.
/// The segment rules live on the thread screen.
///
/// Two slots sit in a row above the first block, on the text edge: `status`
/// (the state line, drawn at the meta step) and `action` (the Start control
/// or the build chip; a `PillButton` or anything on `.buttonStyle(.pressable)`).
/// The row exists only through the two-slot init; the plain init draws none.
struct PlanView<Status: View, Action: View>: View {
    let sessionId: String
    let document: String?
    let running: Bool
    private let hasHeader: Bool
    private let status: Status
    private let action: Action
    @Environment(\.markdownScope) private var scope

    init(sessionId: String, document: String?, running: Bool, @ViewBuilder status: () -> Status, @ViewBuilder action: () -> Action) {
        self.init(sessionId: sessionId, document: document, running: running, hasHeader: true, status: status(), action: action())
    }

    private init(sessionId: String, document: String?, running: Bool, hasHeader: Bool, status: Status, action: Action) {
        self.sessionId = sessionId
        self.document = document
        self.running = running
        self.hasHeader = hasHeader
        self.status = status
        self.action = action
    }

    var body: some View {
        let key = ThreadCaches.planKey(scope.environmentId, sessionId)
        PlanPage(key: key, text: document ?? ThreadCaches.plans.cached(key), running: running, cache: document != nil) { document in
            if hasHeader {
                PlanPageHeader(status: status, action: action)
                    .rowAppearTransition()
                    .animation(Motion.rowAppear, value: hasHeader)
            }
            PlanDocumentView(document: document)
        }
    }
}

extension PlanView where Status == EmptyView, Action == EmptyView {
    /// The page alone: what the thread screen calls.
    init(sessionId: String, document: String?, running: Bool) {
        self.init(sessionId: sessionId, document: document, running: running, hasHeader: false, status: EmptyView(), action: EmptyView())
    }
}

/// The status and action slots in one row at the top of the measure:
/// status at the meta step, the action trailing, both on the first text
/// baseline. 32 pt tall at least, 8 pt before the first block.
struct PlanPageHeader<Status: View, Action: View>: View {
    let status: Status
    let action: Action

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            status
                .textStep(.meta)
            Spacer(minLength: 12)
            action
        }
        .frame(maxWidth: .infinity, minHeight: PlanType.headerHeight, alignment: .leading)
        .padding(.bottom, PlanType.headerBelow)
    }
}

/// One document page: the scroll view, the measure and its insets, the
/// reading position remembered per key, the cache write, the empty line and
/// the no-animation transaction. `content` draws inside the measure once the
/// text has parsed; the default is the whole document. A sibling composes
/// `PlanDocumentView(document:range:)` runs with its own views between
/// them, keeping the block ids the document's indices so the position
/// memory keeps working.
struct PlanPage<Content: View>: View {
    let key: String
    let text: String?
    let running: Bool
    /// Whether `text` is live and should be remembered for the next open.
    let cache: Bool
    let content: (PlanDocument) -> Content

    private enum Restore {
        /// No non-empty document yet.
        case fresh
        /// The saved position is on its way; nothing is saved meanwhile.
        case restoring
        /// Every change of the top block is saved.
        case live
    }

    @State private var position = ScrollPosition(idType: Int.self)
    @State private var restore = Restore.fresh

    init(key: String, text: String?, running: Bool, cache: Bool = true, @ViewBuilder content: @escaping (PlanDocument) -> Content) {
        self.key = key
        self.text = text
        self.running = running
        self.cache = cache
        self.content = content
    }

    var body: some View {
        let pages = ThreadCaches.plans
        let document = text.flatMap { pages.document(key, text: $0) }
        let empty = text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if empty {
                    Text(running ? "Writing the plan…" : "No plan yet")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.top, PlanType.pageTop + 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityAddTraits(running ? .updatesFrequently : [])
                } else if let document {
                    content(document)
                } else if let text {
                    // A long plan on its first paint: plain text at the same
                    // size until the parse lands, so only the styling changes.
                    Text(text)
                        .font(.body)
                        .lineSpacing(PlanType.lineSpacing)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: PlanType.measure, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, PlanType.inset)
            .padding(.top, PlanType.pageTop)
            .padding(.bottom, PlanType.pageBottom)
            .textSelection(.enabled)
            .transaction { $0.animation = nil }
        }
        .scrollPosition($position, anchor: .top)
        .onChange(of: text, initial: true) { _, now in
            if cache, let now { pages.remember(key, text: now) }
        }
        .onChange(of: document?.textHash, initial: true) { _, _ in
            guard restore == .fresh, let document, !document.isEmpty else { return }
            let saved = pages.position(key)
            guard saved > 0, saved < document.blocks.count else {
                restore = .live
                return
            }
            restore = .restoring
            // After this layout pass, so the lazy stack knows the id; never animated.
            Task { @MainActor in
                withTransaction(Transaction(animation: nil)) {
                    position.scrollTo(id: saved, anchor: .top)
                }
                restore = .live
            }
        }
        .onChange(of: position.viewID(type: Int.self)) { _, id in
            guard restore == .live, let id else { return }
            pages.savePosition(key, id)
        }
    }
}

extension PlanPage where Content == PlanDocumentView {
    /// The whole document.
    init(key: String, text: String?, running: Bool, cache: Bool = true) {
        self.init(key: key, text: text, running: running, cache: cache) { PlanDocumentView(document: $0) }
    }
}

/// The blocks of `range` (the whole document by default), each carrying
/// its own space above, so an appended block never moves the ones before
/// it. Ids are the document's block indices.
struct PlanDocumentView: View {
    let document: PlanDocument
    let range: Range<Int>?

    init(document: PlanDocument, range: Range<Int>? = nil) {
        self.document = document
        self.range = range
    }

    var body: some View {
        let all = 0..<document.blocks.count
        let shown = range.map { $0.clamped(to: all) } ?? all
        LazyVStack(alignment: .leading, spacing: PlanType.gap) {
            ForEach(shown, id: \.self) { index in
                PlanBlockView(block: document.blocks[index], first: index == 0)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .id(index)
            }
        }
        .scrollTargetLayout()
    }
}

/// One block in the document's type. `first` is the document's first block,
/// which takes no space above.
struct PlanBlockView: View {
    let block: PlanBlock
    let first: Bool

    init(block: PlanBlock, first: Bool) {
        self.block = block
        self.first = first
    }

    var body: some View {
        switch block {
        case .paragraph(let text):
            Text(text.inlineStyled())
                .font(.body)
                .lineSpacing(PlanType.lineSpacing)
        case .heading(let level, let text):
            Text(text.inlineStyled())
                .font(PlanType.heading(level))
                .tracking(PlanType.tracking(level))
                .padding(.top, first ? 0 : PlanType.spaceAbove(level))
                .padding(.bottom, PlanType.spaceBelowHeading)
                .accessibilityAddTraits(.isHeader)
        case .list(let items):
            PlanListView(items: items)
        case .code(let code, _):
            PlanCodeView(text: code)
        case .quote(let text):
            Text(text.inlineStyled())
                .font(.body)
                .lineSpacing(PlanType.lineSpacing)
                .foregroundStyle(.secondary)
                .padding(.leading, 12)
                .padding(.vertical, 2)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(Color(.tertiaryLabel))
                        .frame(width: 2)
                }
        case .rule:
            Hairline()
                .padding(.vertical, PlanType.ruleInset)
        case .table(let table):
            PlanTableView(table: table)
        }
    }
}

/// A fence as a document's code, not a terminal's: mono one step down,
/// never wrapped (it scrolls sideways), no language header and no line
/// numbers, folded past 40 lines, copied from the context menu. The fold
/// is the one thing in the page that animates.
struct PlanCodeView: View {
    let text: String
    @State private var expanded = false

    var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let folds = lines.count > PlanType.codeFold
        let shown = folds && !expanded ? Array(lines.prefix(PlanType.codeFold)) : Array(lines)
        VStack(alignment: .leading, spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(shown.joined(separator: "\n"))
                    .font(.system(PlanType.mono, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(PlanType.codePadding)
            }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            if folds {
                Button(expanded ? "Show less" : "Show all \(lines.count) lines") {
                    expanded.toggle()
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .buttonStyle(.pressable)
                .frame(minHeight: PlanType.headerHeight)
                .padding(.horizontal, PlanType.codePadding)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Surface.fill.opacity(0.5), in: RoundedRectangle.corner(Radius.row))
        .animation(expanded ? Motion.expand : Motion.collapse, value: expanded)
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
        }
    }
}

/// A list with hanging indents: the marker sits in a fixed column, the text
/// starts after it and wraps to its own edge; each depth moves one column
/// in. A task item carries the board's status glyph.
private struct PlanListView: View {
    let items: [PlanListItem]
    @ScaledMetric(relativeTo: .body) private var column: CGFloat = 26

    var body: some View {
        VStack(alignment: .leading, spacing: PlanType.itemGap) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    marker(item)
                        .padding(.trailing, 8)
                        .frame(width: column, alignment: .trailing)
                    Text(item.text.inlineStyled())
                        .font(.body)
                        .lineSpacing(PlanType.lineSpacing)
                        .foregroundStyle(item.checked == true ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                }
                .padding(.leading, CGFloat(item.depth) * column)
            }
        }
    }

    @ViewBuilder
    private func marker(_ item: PlanListItem) -> some View {
        if let checked = item.checked {
            Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                .font(.subheadline)
                .foregroundStyle(checked ? AnyShapeStyle(Tint.success) : AnyShapeStyle(.tertiary))
                .accessibilityLabel(checked ? "Done" : "To do")
        } else if let number = item.number {
            Text("\(number).")
                .font(.body)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        } else {
            Text(item.depth == 0 ? "•" : item.depth == 1 ? "◦" : "▪")
                .font(.body)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        }
    }
}

/// A pipe table one step down from body, as wide as its content and
/// scrolling sideways past the page: the header semibold over a hairline,
/// a dimmer hairline between rows, none under the last, no vertical rules,
/// the first column on the text edge. Each cell draws the rule under
/// itself, so the rules run exactly the table's width.
private struct PlanTableView: View {
    let table: PlanTable

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(table.header.enumerated()), id: \.offset) { column, cell in
                        PlanCell(text: cell, alignment: table.alignments[column], header: true, first: column == 0, rule: 1)
                    }
                }
                ForEach(Array(table.rows.enumerated()), id: \.offset) { row, cells in
                    GridRow {
                        ForEach(Array(cells.enumerated()), id: \.offset) { column, cell in
                            PlanCell(text: cell, alignment: table.alignments[column], header: false, first: column == 0, rule: row < table.rows.count - 1 ? 0.6 : 0)
                        }
                    }
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .padding(.vertical, 2)
    }
}

private struct PlanCell: View {
    let text: AttributedString
    let alignment: PlanTable.Alignment
    let header: Bool
    let first: Bool
    /// The opacity of the hairline under this cell; 0 for none.
    let rule: Double

    var body: some View {
        let horizontal: HorizontalAlignment = alignment == .center ? .center : alignment == .trailing ? .trailing : .leading
        // A horizontal scroll view proposes no width: a short cell takes
        // its own, a long one wraps at the cell width.
        let long = text.characters.count > PlanType.cellWrapAfter
        Text(text.inlineStyled())
            .font(header ? PlanType.table.weight(.semibold) : PlanType.table)
            .monospacedDigit()
            .multilineTextAlignment(alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
            .fixedSize(horizontal: !long, vertical: true)
            .frame(width: long ? PlanType.cellWrap : nil, alignment: Alignment(horizontal: horizontal, vertical: .center))
            .padding(.vertical, 8)
            .padding(.leading, first ? 0 : 16)
            .padding(.trailing, 16)
            .frame(maxHeight: .infinity, alignment: .top)
            .overlay(alignment: .bottom) {
                if rule > 0 { Hairline().opacity(rule) }
            }
            .gridColumnAlignment(horizontal)
    }
}

// MARK: - the research report

struct ReportRoute: Hashable {
    let sessionId: String
    let title: String
    let body: String
}

/// A research report, opened from its pin: the same set page as the plan.
/// Kept while the thread screen routes to it; the research thread's own
/// screen replaces both.
struct ReportScreen: View {
    let route: ReportRoute
    @Environment(\.markdownScope) private var scope

    var body: some View {
        PlanPage(key: ThreadCaches.planKey(scope.environmentId, route.sessionId) + "/report", text: route.body, running: false, cache: false)
            .background(Surface.background)
            .navigationTitle(route.title)
            .navigationBarTitleDisplayMode(.inline)
    }
}

extension ThreadCaches {
    /// The plan pages' store; one per process.
    static let plans = PlanPages()

    /// A page's key in `PlanPages`: the host and the thread, so two hosts
    /// never share a slot.
    static func planKey(_ environmentId: String, _ sessionId: String) -> String {
        "\(environmentId)/\(sessionId)"
    }

    /// A negative seq for a thread's document, so it caches beside the rows.
    static func documentSeq(_ sessionId: String) -> Int {
        -2 - abs(sessionId.hashValue % 1_000_000) * 2
    }
}
