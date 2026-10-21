import SwiftUI
import TempCodeClient
import TempCodeContract

// The thread screen's frame pieces: the header in the navigation bar, the
// segmented control under it, the toolbar's fleet button and menu, and the
// line a thread leaves behind when it is moved or deleted. Shared tokens and
// motion come from Design/; nothing here inlines a duration.

// MARK: - header

/// The navigation bar's principal item, the way Messages and Notes title a
/// screen: the thread's title, and under it one quiet line with the status
/// mark, the type tinted, the model, and the elapsed time ticking in tabular
/// digits while the thread is live. The host leads that line only when more
/// than one is paired, and only when it fits. Long-press renames.
struct ThreadHeader: View {
    let session: SessionMeta?
    /// The title to keep showing once the session is gone.
    let fallbackTitle: String?
    /// The host's name when more than one host is paired, else nil.
    let hostName: String?
    let onRename: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 2) {
            ZStack {
                Text(title)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .id(title)
                    .transition(Motion.swap(reduced: reduceMotion))
            }
            .animation(Motion.crossFade, value: title)
            if let session {
                Subtitle(session: session, hostName: hostName)
            }
        }
        .contentShape(Rectangle())
        .onLongPressGesture(minimumDuration: 0.4) { if session != nil { onRename() } }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityAction(named: "Rename") { onRename() }
    }

    private var title: String {
        guard let session else { return fallbackTitle ?? "Thread" }
        if session.title.isEmpty { return session.parentId == nil ? "Untitled" : "Subagent" }
        return session.title
    }

    /// The one line under the title. A live thread ticks once a second; the
    /// whole line sits inside the timeline so one clock drives it.
    private struct Subtitle: View {
        let session: SessionMeta
        let hostName: String?

        var body: some View {
            if live {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    line(now: context.date)
                }
            } else {
                line(now: .now)
            }
        }

        private var live: Bool { session.status == .running || session.status == .starting }

        /// Idle and done carry no mark, so the line stays centered under the title.
        private var showsMark: Bool {
            switch session.status {
            case .idle, .done, .unknown: false
            default: true
            }
        }

        private func line(now: Date) -> some View {
            HStack(spacing: 5) {
                if showsMark {
                    StatusDot(status: session.status)
                        .transition(.opacity)
                }
                ViewThatFits(in: .horizontal) {
                    text(now: now, host: hostName)
                    text(now: now, host: nil)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .animation(Motion.crossFade, value: showsMark)
        }

        @ViewBuilder
        private func text(now: Date, host: String?) -> some View {
            HStack(spacing: 5) {
                if let host {
                    Text(host)
                        .foregroundStyle(.tertiary)
                    Separator()
                }
                if session.parentId != nil {
                    Text(session.agentType.label)
                } else if let type = session.threadType {
                    Text(type.label)
                        .fontWeight(.medium)
                        .foregroundStyle(type.tint)
                }
                Separator()
                Text(ModelName.short(session.model))
                if live {
                    Separator()
                    let elapsed = TimeFormat.elapsed(since: session.busySince ?? session.updatedAt, now: now)
                    Text(elapsed)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .animation(Motion.crossFade, value: elapsed)
                        .accessibilityLabel("Running for \(elapsed)")
                } else if session.status == .paused, let frozen = session.frozenActiveElapsed {
                    Separator()
                    Text(TimeFormat.duration(ms: frozen))
                        .monospacedDigit()
                }
            }
        }
    }

    /// The middle dot between the subtitle's parts, a step quieter than them.
    private struct Separator: View {
        var body: some View {
            Text("·")
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
    }
}

// MARK: - toolbar

/// The toolbar's way into the fleet: the agent glyph with the running count
/// beside it in tabular digits. The screen shows it only once the thread has
/// spawned subagents; a fleet with nothing running shows the glyph alone.
struct AgentsButton: View {
    let running: Int
    let total: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 3) {
                Image(systemName: "person.2")
                if running > 0 {
                    Text("\(running)")
                        .font(.footnote)
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .transition(.opacity)
                }
            }
            .animation(Motion.crossFade, value: running)
            .frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("Subagents")
        .accessibilityValue(running > 0 ? "\(running) of \(total) running" : "\(total)")
        .accessibilityIdentifier("thread-agents")
    }
}

/// The ellipsis menu: Rename, Pin and Archive, the same three the thread row
/// offers on Home, through the same calls. A key that cannot act sees them
/// disabled with the reason as the menu's first line. A subagent only renames.
struct ThreadMenu: View {
    let client: EnvironmentClient
    let session: SessionMeta
    let onRename: () -> Void
    let onFailure: (String) -> Void

    private var block: ActionBlock? { client.operateBlock }

    var body: some View {
        Menu {
            if let block {
                Text(block.text(now: Date().timeIntervalSince1970 * 1000))
            }
            Button(action: onRename) {
                Label("Rename…", systemImage: "pencil")
            }
            .disabled(block != nil)
            if session.parentId == nil {
                Button {
                    act { try await client.setPinned(session.id, !session.pinned) }
                } label: {
                    Label(session.pinned ? "Unpin" : "Pin", systemImage: session.pinned ? "pin.slash" : "pin")
                }
                .disabled(block != nil)
                Button {
                    act { try await client.setArchived(session.id, !session.archived) }
                } label: {
                    Label(session.archived ? "Unarchive" : "Archive", systemImage: session.archived ? "tray.and.arrow.up" : "archivebox")
                }
                .disabled(block != nil)
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel("More")
        .accessibilityIdentifier("thread-menu")
    }

    private func act(_ body: @escaping () async throws -> Void) {
        Task {
            do {
                try await body()
            } catch {
                onFailure((error as? ActionError)?.message ?? String(describing: error))
            }
        }
    }
}

// MARK: - gone

/// What a thread leaves behind when it was moved or deleted while open:
/// one quiet line where the body was, the way compaction and system rows
/// read in the transcript. Nothing else on the screen can act any more.
struct GoneLine: View {
    let reason: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack {
            HStack(spacing: 8) {
                Image(systemName: "minus.circle")
                Text(reason)
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 16)
            .padding(.top, 40)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
        .transition(Motion.appear(reduced: reduceMotion))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("thread-gone")
    }
}

// MARK: - segments

/// The segmented control under the header. The raised pill is bound to the
/// pager: `progress` is the pager's offset in pages, so during a swipe the
/// pill follows the finger and on a tap it settles with the drawer curve the
/// parent animates the page with. Each label's color follows the same
/// offset (a primary copy over a secondary one, weighted by how close the
/// pill is), so the recolor is one continuous movement with the pill and
/// never a swap of two states. A warning dot beside the inactive segment's
/// label marks a new needs-you card there; the label itself never moves.
struct SegmentBar: View {
    let segments: [Segment]
    let selected: Segment
    let dot: Segment?
    /// The pager's offset in pages, 0 ... segments.count - 1, continuous.
    let progress: CGFloat
    let onSelect: (Segment) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Concentric: the pill's radius plus its inset is the track's radius.
    static let trackRadius: CGFloat = 9
    static let inset: CGFloat = 2
    static let pillRadius: CGFloat = trackRadius - inset
    static let height: CGFloat = 32

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(segments.enumerated()), id: \.element) { index, segment in
                Button {
                    onSelect(segment)
                } label: {
                    label(segment, weight: weight(of: index))
                        .frame(maxWidth: .infinity, minHeight: Self.height - 2 * Self.inset)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.pressable)
                .accessibilityAddTraits(segment == selected ? [.isSelected] : [])
                .accessibilityIdentifier("segment-\(segment.rawValue)")
            }
        }
        .padding(Self.inset)
        .animation(reduceMotion ? Motion.crossFade : Motion.expand, value: dot)
        .background { pill }
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: Self.trackRadius, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Segment")
        .accessibilityIdentifier("thread-segments")
    }

    /// How much of the pill sits under this segment, 0 ... 1.
    private func weight(of index: Int) -> CGFloat {
        let position = min(max(progress, 0), CGFloat(max(1, segments.count) - 1))
        return max(0, 1 - abs(position - CGFloat(index)))
    }

    /// The label: the primary copy fades in over the secondary one as the
    /// pill arrives, the two sharing one press scale. The dot hangs off the
    /// text's trailing edge so the text never moves when it appears.
    private func label(_ segment: Segment, weight: CGFloat) -> some View {
        ZStack {
            Text(segment.title)
                .foregroundStyle(.secondary)
                .opacity(1 - weight)
            Text(segment.title)
                .foregroundStyle(.primary)
                .opacity(weight)
        }
        .font(.subheadline.weight(.medium))
        .lineLimit(1)
        .overlay(alignment: .trailing) {
            if segment == dot {
                Circle()
                    .fill(Tint.warning)
                    .frame(width: 6, height: 6)
                    .offset(x: 10)
                    .transition(dotTransition)
                    .accessibilityLabel("Needs you")
            }
        }
    }

    /// The raised pill: white with a soft shadow in light, the raised step in dark.
    private var pill: some View {
        GeometryReader { geometry in
            let rect = pillRect(in: geometry.size)
            RoundedRectangle(cornerRadius: Self.pillRadius, style: .continuous)
                .fill(Color(.tertiarySystemBackground))
                .shadow(color: .black.opacity(0.12), radius: 2, y: 1)
                .frame(width: rect.width, height: rect.height)
                .offset(x: rect.minX, y: rect.minY)
        }
    }

    /// The pill's rectangle at the pager's offset, in the bar's own coordinates.
    private func pillRect(in size: CGSize) -> CGRect {
        let count = CGFloat(max(1, segments.count))
        let width = (size.width - 2 * Self.inset) / count
        let position = min(max(progress, 0), count - 1)
        return CGRect(x: Self.inset + position * width, y: Self.inset, width: width, height: size.height - 2 * Self.inset)
    }

    /// The dot appears like an icon (scale 0.25 and opacity, no bounce) and
    /// leaves by opacity; reduced motion fades both ways.
    private var dotTransition: AnyTransition {
        reduceMotion
            ? .opacity
            : .asymmetric(insertion: .scale(scale: 0.25).combined(with: .opacity), removal: .opacity)
    }
}
