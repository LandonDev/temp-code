import SwiftUI

/// Section chrome on the one gray step: a name, a dim branch, the worktree
/// mark when the project runs in one, and whatever trails (a count, a fold,
/// a `+`). The band runs edge to edge; its title sits on the text edge like
/// the rows under it, and its glyphs carry the title's semibold stroke.
struct SectionHeader<Trailing: View>: View {
    let title: String
    var branch: String?
    var worktree = false
    let trailing: Trailing

    init(_ title: String, branch: String? = nil, worktree: Bool = false, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.branch = branch
        self.worktree = worktree
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(title)
                .textStep(.meta, weight: .semibold)
                .lineLimit(1)
            if worktree {
                MetaGlyph("arrow.triangle.pull", weight: .semibold, label: "Worktree")
            }
            if let branch {
                Text(branch)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(.horizontal, Layout.textEdge)
        .frame(maxWidth: .infinity, minHeight: 30)
        .background(Surface.chrome)
        .textCase(nil)
        .accessibilityAddTraits(.isHeader)
    }
}

extension SectionHeader where Trailing == EmptyView {
    init(_ title: String, branch: String? = nil, worktree: Bool = false) {
        self.init(title, branch: branch, worktree: worktree) { EmptyView() }
    }
}

/// A header above an inset-grouped card: the system's grouped-list voice
/// (footnote, secondary, uppercase off) on the text edge, with room under
/// it. Use it where a screen is a few short groups rather than a long list:
/// Settings, a sheet, a detail.
struct GroupHeader<Trailing: View>: View {
    let title: String
    let trailing: Trailing

    init(_ title: String, @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(title)
                .textStep(.meta, weight: .semibold)
                .lineLimit(1)
            Spacer(minLength: 8)
            trailing
        }
        .padding(.horizontal, Layout.textEdge)
        .padding(.top, 20)
        .padding(.bottom, 6)
        .textCase(nil)
        .accessibilityAddTraits(.isHeader)
    }
}

extension GroupHeader where Trailing == EmptyView {
    init(_ title: String) {
        self.init(title) { EmptyView() }
    }
}
