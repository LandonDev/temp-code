import SwiftUI
import TempCodeClient

/// The plan file as the page: a set document at body size, streaming in as
/// the agent writes it. The last text seen paints at once from the plan
/// cache; a plan with no content yet is one quiet line, never a spinner.
/// The Start action and the segment rules live on the thread screen.
struct PlanView: View {
    let sessionId: String
    let document: String?
    let running: Bool

    var body: some View {
        PlanPage(key: sessionId, text: document ?? PlanPages.shared.cached(sessionId), running: running, cache: document != nil)
    }
}

/// One document page: the blocks of `PlanDocument`, the reading position
/// remembered per key, and content that only ever appends below the reader.
struct PlanPage: View {
    let key: String
    let text: String?
    let running: Bool
    /// Whether `text` is live and should be remembered for the next open.
    var cache = true

    @State private var position = ScrollPosition(idType: Int.self)
    @State private var restored = false
    @State private var width: CGFloat = 0

    var body: some View {
        let pages = PlanPages.shared
        let document = text.map { pages.document(key, text: $0) }
        let empty = text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true
        ScrollView {
            Group {
                if empty {
                    Text(running ? "Writing the plan…" : "No plan yet")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.top, PlanType.pageTop + 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityAddTraits(.updatesFrequently)
                } else if let document {
                    PlanDocumentView(document: document, width: width)
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
        .onGeometryChange(for: CGFloat.self) { proxy in
            min(proxy.size.width, PlanType.measure + 2 * PlanType.inset) - 2 * PlanType.inset
        } action: { width = $0 }
        .onChange(of: text, initial: true) { _, now in
            if cache, let now { pages.remember(key, text: now) }
        }
        .onChange(of: document?.textHash, initial: true) { _, _ in
            guard !restored, let document, !document.isEmpty else { return }
            restored = true
            let saved = pages.position(key)
            guard saved > 0, saved < document.blocks.count else { return }
            // After this layout pass, so the lazy stack knows the id; no animation.
            Task { @MainActor in position.scrollTo(id: saved, anchor: .top) }
        }
        .onChange(of: position.viewID(type: Int.self)) { _, id in
            guard restored, let id else { return }
            pages.savePosition(key, id)
        }
    }
}

/// The blocks, each carrying its own space above, so an appended block
/// never moves the ones before it.
private struct PlanDocumentView: View {
    let document: PlanDocument
    let width: CGFloat

    var body: some View {
        LazyVStack(alignment: .leading, spacing: PlanType.gap) {
            ForEach(Array(document.blocks.enumerated()), id: \.offset) { index, block in
                PlanBlockView(block: block, first: index == 0, width: width)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .id(index)
            }
        }
        .scrollTargetLayout()
    }
}

private struct PlanBlockView: View {
    let block: PlanBlock
    let first: Bool
    let width: CGFloat

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
            CodeBlock(text: code, font: PlanType.mono, maxLines: 40)
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
            PlanTableView(table: table, minWidth: width)
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

/// A pipe table one step down from body, scrolling sideways when wider
/// than the page: the header semibold over a hairline, a hairline between
/// rows, no vertical rules, the first column on the text edge.
private struct PlanTableView: View {
    let table: PlanTable
    let minWidth: CGFloat

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(table.header.enumerated()), id: \.offset) { column, cell in
                        PlanCell(text: cell, alignment: table.alignments[column], header: true, first: column == 0)
                    }
                }
                Hairline()
                ForEach(Array(table.rows.enumerated()), id: \.offset) { row, cells in
                    GridRow {
                        ForEach(Array(cells.enumerated()), id: \.offset) { column, cell in
                            PlanCell(text: cell, alignment: table.alignments[column], header: false, first: column == 0)
                        }
                    }
                    if row < table.rows.count - 1 {
                        Hairline().opacity(0.6)
                    }
                }
            }
            .frame(minWidth: minWidth, alignment: .leading)
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

    var body: some View {
        Text(text.inlineStyled())
            .font(header ? PlanType.table.weight(.semibold) : PlanType.table)
            .monospacedDigit()
            .multilineTextAlignment(alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: 280, alignment: alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
            .padding(.vertical, 8)
            .padding(.leading, first ? 0 : 16)
            .padding(.trailing, 16)
            .gridColumnAlignment(alignment == .center ? .center : alignment == .trailing ? .trailing : .leading)
    }
}

// MARK: - the plan cache

/// The pages' store: the last text of every plan and report on disk, so the
/// next open paints before the socket answers; the rendered document per
/// page, kept through a re-parse so a poll never drops the page to plain
/// text; and the reading position per page.
@MainActor @Observable
final class PlanPages {
    static let shared = PlanPages()

    /// A page's rendered document: what its view observes.
    @Observable
    final class Slot {
        var document: PlanDocument?
    }

    /// Texts at or under this size parse on the first paint instead of a
    /// frame of plain text.
    static let syncLimit = 6 * 1024

    @ObservationIgnored private var texts: [String: String] = [:]
    @ObservationIgnored private var read: Set<String> = []
    @ObservationIgnored private var slots: [String: Slot] = [:]
    @ObservationIgnored private var ready: [String: PlanDocument] = [:]
    @ObservationIgnored private var inflight: [String: Int] = [:]
    @ObservationIgnored private let directory: URL

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "plans", directoryHint: .isDirectory)
    }

    /// The last text seen for a page, from memory, else from disk once.
    func cached(_ key: String) -> String? {
        if let text = texts[key] { return text }
        guard !read.contains(key) else { return nil }
        read.insert(key)
        guard let text = try? String(contentsOf: url(key), encoding: .utf8) else { return nil }
        texts[key] = text
        return text
    }

    /// Keeps a page's live text for its next open.
    func remember(_ key: String, text: String) {
        guard texts[key] != text else { return }
        texts[key] = text
        read.insert(key)
        let file = url(key)
        let directory = directory
        Task.detached(priority: .utility) {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? text.write(to: file, atomically: true, encoding: .utf8)
        }
    }

    /// The document for this text: parsed now on a page's first paint when
    /// the text is short, otherwise off the main actor while the page keeps
    /// the document it had.
    func document(_ key: String, text: String) -> PlanDocument? {
        let hash = text.hashValue
        let slot = slot(key)
        if let document = slot.document, document.textHash == hash { return document }
        if let document = ready[key], document.textHash == hash { return document }
        if slot.document == nil, ready[key] == nil, text.utf8.count <= Self.syncLimit {
            let document = PlanDocument.parse(text)
            ready[key] = document
            return document
        }
        if inflight[key] != hash {
            inflight[key] = hash
            Task {
                let document = await PlanDocument.render(text)
                guard self.inflight[key] == hash else { return }
                self.inflight[key] = nil
                self.ready[key] = nil
                slot.document = document
            }
        }
        return slot.document ?? ready[key]
    }

    func position(_ key: String) -> Int {
        UserDefaults.standard.integer(forKey: "plan.position.\(key)")
    }

    func savePosition(_ key: String, _ index: Int) {
        UserDefaults.standard.set(index, forKey: "plan.position.\(key)")
    }

    private func slot(_ key: String) -> Slot {
        if let slot = slots[key] { return slot }
        let slot = Slot()
        slots[key] = slot
        return slot
    }

    private func url(_ key: String) -> URL {
        let safe = key.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || $0 == "-" ? String($0) : "_" }.joined()
        return directory.appending(path: "\(safe).md")
    }
}

// MARK: - the research report

struct ReportRoute: Hashable {
    let sessionId: String
    let title: String
    let body: String
}

/// A research report, opened from its pin: the same set page as the plan.
struct ReportScreen: View {
    let route: ReportRoute

    var body: some View {
        PlanPage(key: "\(route.sessionId)/report", text: route.body, running: false, cache: false)
            .background(Surface.background)
            .navigationTitle(route.title)
            .navigationBarTitleDisplayMode(.inline)
    }
}

extension ThreadCaches {
    /// A negative seq for a thread's document, so it caches beside the rows.
    static func documentSeq(_ sessionId: String) -> Int {
        -2 - abs(sessionId.hashValue % 1_000_000) * 2
    }
}
