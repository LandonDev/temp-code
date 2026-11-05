import SwiftUI
import TempCodeClient
import TempCodeContract

/// The project shell's thread strip, the desktop's title-bar strip
/// (ThreadHeaderStrip.tsx) at the shell's top in every pose: a 40 pt live row
/// of the project's live roots in their saved order (`ThreadStripStore`), the
/// outside chip last, then New Thread outside the row's scroll. At regular
/// width the settled roots are a 32 pt shelf row under it, drawn only while it
/// holds a chip; at compact width they are the Recent menu at the live row's
/// end, freshest first, with the archived lists at its foot, and the thread
/// on screen keeps a chip at the live row's end when it is settled
/// (`StripModel.compact`). The rules are the
/// client package's `ThreadStrip` and `StripChip.look`; this file draws them.
///
/// Docked chrome inside the content: the background with a hairline under it,
/// no shadow and no glass. A chip's tap selects its thread in the shell at
/// once; nothing in a row moves (a chip is a switch used tens of times a day).
/// The shelf folds in and out on the layout spring.
struct ThreadStripView: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    @Environment(NewThreadPresenter.self) private var presenter
    @Environment(\.shellPose) private var pose
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let scope: StripScope
    let shown: (environmentId: String, sessionId: String)?
    @State private var width: CGFloat = 0
    @ScaledMetric(relativeTo: .footnote) private var rowHeight = StripMetrics.row
    @ScaledMetric(relativeTo: .caption) private var shelfHeight = StripMetrics.shelfRow

    var body: some View {
        let hosts = HomeRows.inputs(model.registry.ordered)
        let model = ThreadStrip.model(scope: scope, shown: shown, order: ThreadStripStore.shared.order(scope.key), hosts: hosts)
        let strip = pose.isSplit ? model : model.compact
        let shelfShown = pose.isSplit && !strip.shelf.isEmpty
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                chipRow(strip.live, onShelf: false)
                newThread(words: strip.live.isEmpty)
                if !pose.isSplit, !strip.shelf.isEmpty || !scope.archived.isEmpty {
                    RecentMenu(scope: scope, shelf: strip.shelf, open: open)
                }
            }
            .frame(height: rowHeight)
            if shelfShown {
                chipRow(strip.shelf, onShelf: true)
                    .frame(height: shelfHeight)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .clipped()
        .animation(reduceMotion ? Motion.fast : Motion.layout, value: shelfShown)
        .background(Surface.background)
        .overlay(alignment: .bottom) { Hairline() }
        // The drawn order is the order kept; the outside chip never is.
        .onChange(of: model.saveIds, initial: true) { ThreadStripStore.shared.save(scope.key, model: model) }
    }

    private func chipRow(_ chips: [StripChip], onShelf: Bool) -> some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: StripMetrics.chipGap) {
                    ForEach(chips) { chip in
                        StripChipView(chip: chip, onShelf: onShelf) { open(chip) }
                            .id(chip.id)
                            // The thread's menu on a long press: the rows' own.
                            .modifier(ChipActions(chip: chip))
                    }
                }
                // The first chip's fill half the text edge in, so its glyph sits clear of the bar's back button.
                .padding(.horizontal, Layout.textEdge / 2)
            }
            .scrollIndicators(.hidden)
            .mask { EdgeFade() }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            // The selected chip into view on a change of selection, of the chips (a restore
            // paints them whole), or of the row's width (a fold); never animated.
            .onChange(of: scrollKey(chips), initial: true) {
                guard let selected = chips.first(where: \.selected)?.id else { return }
                Motion.withoutAnimation { proxy.scrollTo(selected, anchor: nil) }
            }
        }
    }

    /// New Thread after the live row, outside its scroll: the glyph, or the
    /// words while the row holds no chip.
    @ViewBuilder
    private func newThread(words: Bool) -> some View {
        if let lead = scope.lead, let client = model.registry.client(lead.environmentId),
           let workspace = client.workspaces.first(where: { $0.id == lead.workspaceId }) {
            let project = lead.projectId.flatMap { id in client.projects.first { $0.id == id } }
            Button { presenter.compose(client, workspace, project) } label: {
                if words {
                    Label("New Thread", systemImage: "square.and.pencil")
                        .labelStyle(.titleAndIcon)
                        .transcriptType(TranscriptType.line, weight: .medium)
                        .padding(.horizontal, StripMetrics.chipPadding)
                } else {
                    Image(systemName: "square.and.pencil")
                        .transcriptFont(TranscriptType.line, weight: .medium)
                        .frame(width: TranscriptMetrics.hitArea)
                        .accessibilityLabel("New Thread")
                }
            }
            .frame(minHeight: TranscriptMetrics.hitArea)
            .contentShape(Rectangle())
            .buttonStyle(.pressable)
            .foregroundStyle(.secondary)
            .frame(maxWidth: words ? .infinity : nil, alignment: .leading)
        }
    }

    private func open(_ chip: StripChip) {
        navigator.open(.project(key: scope.key, thread: chip.id))
    }

    private func scrollKey(_ chips: [StripChip]) -> String {
        "\(chips.first(where: \.selected)?.id ?? "")|\(chips.map(\.id).joined(separator: ","))|\(Int(width))"
    }
}

/// Compact width's shelf: the clock at the live row's end, a menu of the
/// settled roots freshest first, "Archived Threads" at its foot pushing the
/// archived list over the shell (one row per host copy that has any).
private struct RecentMenu: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    let scope: StripScope
    let shelf: [StripChip]
    let open: (StripChip) -> Void

    var body: some View {
        Menu {
            Section {
                ForEach(shelf) { chip in
                    Button { open(chip) } label: {
                        Label(chip.meta.title.isEmpty ? "Untitled" : chip.meta.title, systemImage: (chip.meta.threadType ?? .chat).symbol)
                    }
                }
            }
            let archived = scope.archived
            ForEach(archived) { copy in
                Button {
                    navigator.detailStack.append(Route.archivedThreads(environmentId: copy.environmentId, projectId: copy.projectId))
                } label: {
                    Label(label(copy, many: archived.count > 1), systemImage: "archivebox")
                }
            }
        } label: {
            Image(systemName: "clock")
                .transcriptFont(TranscriptType.line, weight: .medium)
                .frame(width: TranscriptMetrics.hitArea, height: TranscriptMetrics.hitArea)
                .contentShape(Rectangle())
        }
        .foregroundStyle(.secondary)
        .accessibilityLabel("Recent Threads")
        .padding(.trailing, Layout.textEdge - (TranscriptMetrics.hitArea - StripMetrics.glyph) / 2)
    }

    private func label(_ copy: HomeSections.ArchivedThreads, many: Bool) -> String {
        guard many, let name = model.registry.client(copy.environmentId)?.environment.name else { return "Archived Threads" }
        return "Archived Threads on \(name)"
    }
}

/// The thread's context menu on its chip, when the client still lists it.
private struct ChipActions: ViewModifier {
    @Environment(AppModel.self) private var model
    let chip: StripChip

    func body(content: Content) -> some View {
        if let client = model.registry.client(chip.environmentId), let meta = client.session(chip.meta.id) {
            content.threadRowActions(client: client, meta: meta)
        } else {
            content
        }
    }
}

/// One chip (ThreadHeaderStrip.tsx `StripChip`). Live: 28 pt, 12 pt in, the
/// 14 pt glyph slot (the type glyph at rest, the status mark in its place),
/// the title 13/20, medium and primary while unread with the medium width
/// always held, "Master" muted when pinned, the host glyph with two or more
/// hosts, 224 pt at most. Shelf: 24 pt, 8 pt in, a 12 pt type glyph, the
/// title 12/16 to 160 pt, never a mark. Selected: the fill and the title in
/// primary. No motion: a selection lands at once.
private struct StripChipView: View {
    let chip: StripChip
    let onShelf: Bool
    let tap: () -> Void
    @ScaledMetric(relativeTo: .footnote) private var height = StripMetrics.chip
    @ScaledMetric(relativeTo: .caption) private var shelfHeight = StripMetrics.shelfChip
    /// The title's room in a 224 pt chip: less the padding, the slot and its gap.
    @ScaledMetric(relativeTo: .footnote) private var liveTitleMax = StripMetrics.chipMax - 2 * StripMetrics.chipPadding - StripMetrics.glyph - StripMetrics.glyphGap
    @ScaledMetric(relativeTo: .caption) private var shelfTitleMax = StripMetrics.shelfTitleMax
    @ScaledMetric(relativeTo: .footnote) private var glyphSlot = StripMetrics.glyph
    @ScaledMetric(relativeTo: .caption) private var shelfGlyphSlot = StripMetrics.shelfGlyph

    var body: some View {
        let look = chip.look(onShelf: onShelf)
        let type = onShelf ? TranscriptType.detail : TranscriptType.line
        let title = chip.meta.title.isEmpty ? "Untitled" : chip.meta.title
        Button(action: tap) {
            HStack(spacing: onShelf ? StripMetrics.shelfGlyphGap : StripMetrics.glyphGap) {
                glyph(look.glyph)
                // The medium copy, hidden, holds the width; the drawn title sits over it.
                Text(title)
                    .transcriptType(type, weight: .medium)
                    .lineLimit(1)
                    .hidden()
                    .overlay(alignment: .leading) {
                        Text(title)
                            .transcriptType(type, weight: look.medium ? .medium : .regular)
                            .foregroundStyle(chip.selected || look.medium ? .primary : .secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .frame(maxWidth: onShelf ? shelfTitleMax : liveTitleMax, alignment: .leading)
                if look.master {
                    Text("Master")
                        .transcriptType(type)
                        .foregroundStyle(.tertiary)
                        .fixedSize()
                }
                HostGlyph(environmentId: chip.environmentId)
            }
            .padding(.horizontal, onShelf ? StripMetrics.shelfPadding : StripMetrics.chipPadding)
            .frame(height: onShelf ? shelfHeight : height)
            .background(chip.selected ? Surface.fill : .clear, in: .rowCorner)
            .contentShape(.rowCorner)
        }
        .buttonStyle(.pressableStatic)
        .accessibilityLabel(accessibilityLabel(title))
        .accessibilityAddTraits(chip.selected ? .isSelected : [])
    }

    @ViewBuilder
    private func glyph(_ glyph: StripGlyph) -> some View {
        let slot = onShelf ? shelfGlyphSlot : glyphSlot
        switch glyph {
        case .type(let type):
            Image(systemName: type.symbol)
                .transcriptFont(onShelf ? TranscriptType.detail : TranscriptType.line)
                .imageScale(.small)
                .foregroundStyle(type.tint)
                .frame(width: slot, height: slot)
                .accessibilityHidden(true)
        case .status(let state):
            CardMark(state: state, column: StripMetrics.glyph, dot: StripMetrics.dot, type: TranscriptType.line)
        }
    }

    private func accessibilityLabel(_ title: String) -> String {
        var parts = [title]
        if chip.meta.isMaster == true { parts.append("Master") }
        if case .status(let state) = chip.look(onShelf: onShelf).glyph, let word = StripChipView.word(state) { parts.append(word) }
        if chip.unseen { parts.append("Unread") }
        return parts.joined(separator: ", ")
    }

    private static func word(_ state: CardState) -> String? {
        switch state {
        case .working: "Working"
        case .watching: "Watching"
        case .waiting: "Needs you"
        case .failed: "Failed"
        case .queued: "Queued"
        case .planReady: "Plan ready"
        case .paused: "Paused"
        case .stopped: "Stopped"
        case .idle, .done: nil
        }
    }
}

/// The desktop's faded overflow: 16 pt of fade at both edges of the scroller.
private struct EdgeFade: View {
    var body: some View {
        HStack(spacing: 0) {
            LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing).frame(width: Layout.textEdge)
            Color.black
            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: Layout.textEdge)
        }
    }
}
