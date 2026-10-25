import SwiftUI
import TempCodeClient
import TempCodeContract

/// The desktop's thread strip, above the Home split's detail: one row of
/// chips for the open thread's project's live roots, freshest first, the
/// open thread kept even when dormant, then `+` for a new thread in that
/// project. The project's threads, not a set of open tabs; it repeats what
/// the sidebar nests under the project, as the desktop does. Only in the
/// split poses: the caller shows it there and nowhere else. The rules are
/// the client package's `ThreadStrip`; this file draws them.
///
/// Docked chrome inside the content: the background with a hairline under
/// it, no shadow and no glass. A chip tap swaps the detail root with no
/// animation; the selected wash cross-fades; a chip entering as a thread
/// goes live appears, one leaving fades; nothing animates in the first
/// 300 ms after paint.
struct ThreadStripView: View {
    @Environment(AppModel.self) private var model
    @Environment(ShellNavigator.self) private var navigator
    @Environment(NewThreadPresenter.self) private var presenter
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let route: Route?
    @State private var painted = false
    @State private var width: CGFloat = 0

    var body: some View {
        let hosts = HomeRows.inputs(model.registry.ordered)
        if let scope = ThreadStrip.scope(for: route, hosts: hosts) {
            let chips = ThreadStrip.chips(scope: scope, open: route)
            HStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView(.horizontal) {
                        HStack(spacing: 6) {
                            ForEach(chips) { chip in
                                StripChipView(chip: chip) {
                                    navigator.open(.thread(environmentId: chip.environmentId, sessionId: chip.meta.id, seq: nil))
                                }
                                .id(chip.id)
                                // Pin, archive and rename on a chip: the rows' own menu.
                                .modifier(ChipActions(chip: chip))
                                .transition(painted ? Motion.appear(reduced: reduceMotion) : .identity)
                            }
                        }
                        .padding(.horizontal, Layout.textEdge)
                        .animation(painted ? Motion.rowAppear : nil, value: chips.map(\.id))
                    }
                    .scrollIndicators(.hidden)
                    .scrollClipDisabled(false)
                    .mask { EdgeFade() }
                    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
                    // The selected chip into view: on a change of selection, of the chips (a restore
                    // paints them whole), or of the row's width (a fold).
                    .onChange(of: scrollKey(chips), initial: true) {
                        guard let selected = chips.first(where: \.selected)?.id else { return }
                        Motion.withoutAnimation { proxy.scrollTo(selected, anchor: nil) }
                    }
                }
                if let lead = scope.lead, let client = model.registry.client(lead.environmentId),
                   let workspace = client.workspaces.first(where: { $0.id == lead.workspaceId }) {
                    let project = lead.projectId.flatMap { id in client.projects.first { $0.id == id } }
                    Button("New Thread", systemImage: "square.and.pencil") { presenter.compose(client, workspace, project) }
                        .labelStyle(.iconOnly)
                        .font(.subheadline.weight(.medium))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                        .buttonStyle(.pressable)
                        .padding(.trailing, Layout.textEdge - 8)
                }
            }
            .frame(height: 40)
            .background(Surface.background)
            .overlay(alignment: .bottom) { Hairline() }
            .task {
                // The first paint lands in the first frames; whatever lands after this is an event.
                try? await Task.sleep(for: .milliseconds(300))
                painted = true
            }
        }
    }

    private func scrollKey(_ chips: [StripChip]) -> String {
        "\(chips.first(where: \.selected)?.id ?? "")|\(chips.map(\.id).joined(separator: ","))|\(Int(width))"
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

/// One chip: the type glyph tinted, the title (semibold while unseen: the
/// weight is the whole unread mark, as the Inbox), the host glyph with two
/// or more hosts (`HostGlyph` draws nothing otherwise), the spinner while
/// running; on the fill when selected.
private struct StripChipView: View {
    let chip: StripChip
    let tap: () -> Void
    @ScaledMetric(relativeTo: .footnote) private var glyph: CGFloat = 14

    private var weight: Font.Weight { chip.unseen ? .semibold : .regular }
    private var running: Bool { chip.meta.status == .running || chip.meta.status == .starting || chip.meta.treeHasLiveWork == true }

    var body: some View {
        Button(action: tap) {
            HStack(spacing: 6) {
                Image(systemName: (chip.meta.threadType ?? .chat).symbol)
                    .font(.system(size: glyph, weight: weight))
                    .foregroundStyle((chip.meta.threadType ?? .chat).tint)
                Text(chip.meta.title.isEmpty ? "Untitled" : chip.meta.title)
                    .textStep(.meta, weight: weight, tint: Color(.label))
                    .lineLimit(1)
                    .truncationMode(.tail)
                HostGlyph(environmentId: chip.environmentId)
                if running {
                    ProgressView().controlSize(.mini)
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 28)
            .frame(maxWidth: 180)
            .background(chip.selected ? Surface.fill : .clear, in: .rowCorner)
            .animation(Motion.crossFade, value: chip.selected)
            .contentShape(.rowCorner)
        }
        .buttonStyle(.pressable)
        .accessibilityLabel(chip.meta.title)
        .accessibilityAddTraits(chip.selected ? .isSelected : [])
    }
}

/// The desktop's faded overflow: 16 pt of fade at both edges of the scroller.
private struct EdgeFade: View {
    var body: some View {
        HStack(spacing: 0) {
            LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing).frame(width: 16)
            Color.black
            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 16)
        }
    }
}
