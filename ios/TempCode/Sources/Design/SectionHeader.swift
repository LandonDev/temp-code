import SwiftUI

/// Section chrome on the one gray step: a name, a dim branch, the worktree
/// mark when the project runs in one, and whatever trails (a count, a fold).
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
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if worktree {
                Image(systemName: "arrow.triangle.pull")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .accessibilityLabel("Worktree")
            }
            if let branch {
                Text(branch)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, minHeight: 30)
        .background(Surface.chrome)
        .textCase(nil)
    }
}

extension SectionHeader where Trailing == EmptyView {
    init(_ title: String, branch: String? = nil, worktree: Bool = false) {
        self.init(title, branch: branch, worktree: worktree) { EmptyView() }
    }
}
