import SwiftUI
import TempCodeClient
import TempCodeContract

/// The shell's section furniture: the project sub-header, dim push rows,
/// quiet notes with one action, the plus, the connection dot. Shared by Home
/// and the archived lists; every length and step is a kit name, and nothing
/// here paints a band of chrome.

/// A project under its workspace: the name, the worktree mark when it runs
/// in one, the branch dim, and whatever trails (the plus, a menu). One row
/// for every host's copy; the threads under it carry their hosts' glyphs.
/// A sub-header, not a band: it sits in the list's own flow.
struct ProjectHeaderRow<Trailing: View>: View {
    let project: ProjectMeta
    let trailing: Trailing

    init(project: ProjectMeta, @ViewBuilder trailing: () -> Trailing) {
        self.project = project
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(project.name)
                .textStep(.meta, weight: .semibold)
                .lineLimit(1)
            if project.mode == .worktree {
                MetaGlyph("arrow.triangle.pull", weight: .semibold, label: "Worktree")
            }
            if let branch = project.branch, !branch.isEmpty {
                Text(branch)
                    .font(TextStep.meta.font)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(.top, 10)
        .frame(minHeight: 36)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

extension ProjectHeaderRow where Trailing == EmptyView {
    init(project: ProjectMeta) { self.init(project: project) { EmptyView() } }
}

/// A quiet row that pushes a list: "3 archived", "2 more subagents".
struct DimRow: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(TextStep.meta.font)
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
    }
}

/// One calm sentence and, when one helps, the one action: an empty workspace,
/// a host with nothing, a Home with nothing to do, a note after a restart.
/// Never a blank.
struct QuietNote: View {
    let text: String
    var action: (title: String, run: () -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(text)
                .textStep(.meta)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let action {
                // The pressable style keeps the label's own color, so the action names its tint itself.
                Button(action: action.run) {
                    Text(action.title)
                        .font(TextStep.meta.font.weight(.medium))
                        .foregroundStyle(.tint)
                        .frame(minHeight: Layout.rowHeight)
                }
                .buttonStyle(.pressable)
            }
        }
        .frame(minHeight: Layout.rowHeight)
    }
}

/// The plus at the end of a workspace or project header: a new thread there.
/// 44 pt to the touch, 30 pt to the eye; the stroke follows the semibold
/// name beside it.
struct NewThreadButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(TextStep.title.font.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 30, height: 30)
                .frame(width: Layout.rowHeight, height: Layout.rowHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("New thread")
    }
}

/// A header's trailing menu (a host's or a project's): the ellipsis in the
/// same 44 pt target as the plus beside it.
struct HeaderMenu<Content: View>: View {
    let systemImage: String
    let label: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        Menu(content: content) {
            Image(systemName: systemImage)
                .font(TextStep.title.font.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 30, height: 30)
                .frame(width: Layout.rowHeight, height: Layout.rowHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityLabel(label)
    }
}

/// The transport in one color: open green, trying orange, refused or offline red.
struct ConnectionDot: View {
    let status: EnvironmentStatus

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: Layout.dotSize, height: Layout.dotSize)
            .accessibilityLabel(StatusText.text(for: status, now: .now))
    }

    private var color: Color {
        switch status.transport {
        case .open: Tint.success
        case .connecting, .reconnecting, .suspended: Tint.warning
        case .offline, .unauthorized: Tint.destructive
        }
    }
}
