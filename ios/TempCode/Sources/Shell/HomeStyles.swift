import SwiftUI
import TempCodeClient
import TempCodeContract

/// The shell's section furniture: native headers over a plain list, the
/// project sub-header, dim push rows, quiet notes with one action, and the
/// motion of rows that arrive because of an event. Shared by Home and the
/// archived lists; nothing here paints a band of chrome.
enum HomeStyles {
    /// A needs-you or status row: in with 200 ms ease-out, opacity and 8 pt
    /// of travel; out with 150 ms of opacity. Reduced motion fades both ways.
    static func eventRow(reduced: Bool) -> AnyTransition {
        reduced
            ? .opacity.animation(Motion.crossFade)
            : .asymmetric(
                insertion: .opacity.combined(with: .offset(y: Motion.travel)).animation(Motion.rowAppear),
                removal: .opacity.animation(Motion.rowLeave)
            )
    }

    /// The text edge of a thread row's title: the status mark, the glyph and two gaps.
    static let titleIndent: CGFloat = 14 + 10 + 20 + 10
    /// A subagent row's title: one step further in.
    static let agentIndent: CGFloat = 16 + titleIndent
}

/// A top-level section heading ("Needs you", "Running", "Chats"): the title
/// alone, in the weight iOS gives a prominent list header, sitting on the
/// list background so the sections read as one page.
struct HomeSectionTitle: View {
    let title: String

    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(.title3.weight(.semibold))
            .foregroundStyle(.primary)
            .textCase(nil)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 16)
            .padding(.top, 14)
            .padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A project under its workspace: the name, the worktree mark when it runs
/// in one, the branch dim, and the plus for a thread there. A sub-header,
/// not a band: it sits in the list's own flow.
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
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if project.mode == .worktree {
                Image(systemName: "arrow.triangle.pull")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityLabel("Worktree")
            }
            if let branch = project.branch, !branch.isEmpty {
                Text(branch)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
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
            .font(.footnote)
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
    }
}

/// One calm sentence and the one action that helps: an empty workspace, a
/// host with nothing, a Home with nothing to do. Never a blank.
struct QuietNote: View {
    let text: String
    var action: (title: String, run: () -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(text)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let action {
                // The pressable style keeps the label's own color, so the action names its tint itself.
                Button(action: action.run) {
                    Text(action.title)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(.tint)
                        .frame(minHeight: 44)
                }
                .buttonStyle(.pressable)
            }
        }
        .frame(minHeight: 44)
    }
}

/// The plus at the end of a workspace or project header: a new thread there.
/// 44 pt to the touch, 30 pt to the eye.
struct NewThreadButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("New thread")
    }
}

/// The transport in one color: open green, trying orange, refused or offline red.
struct ConnectionDot: View {
    let status: EnvironmentStatus

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
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
