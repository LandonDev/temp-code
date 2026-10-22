import SwiftUI
import TempCodeClient

/// The Search tab's rows, each a thin draw of one `SearchRow` on the kit's
/// names: no raw inset, color, font or duration here. Emphasis is by weight,
/// never color; glyphs sit in the kit's glyph column at the text's weight;
/// nothing animates but the press scale and a ticking time.

/// The matched text of a search result, set in weight: the runs
/// `MatchRanges` found (character offsets into `text`) go one weight up in
/// the same font and the same color as the rest. Main-actor like the views
/// that call it from `body`; the arithmetic lives in the client package.
enum MatchEmphasis {
    static func attributed(_ text: String, matches: [Range<Int>], step: TextStep, weight: Font.Weight = .semibold) -> AttributedString {
        attributed(text, matches: matches, font: step.font, weight: weight)
    }

    static func attributed(_ text: String, matches: [Range<Int>], font: Font, weight: Font.Weight = .semibold) -> AttributedString {
        var out = AttributedString(text)
        out.font = font
        let strong = font.weight(weight)
        let count = text.count
        for range in matches where range.lowerBound >= 0 && range.upperBound <= count && !range.isEmpty {
            let lower = text.index(text.startIndex, offsetBy: range.lowerBound)
            let upper = text.index(lower, offsetBy: range.count)
            if let from = AttributedString.Index(lower, within: out), let to = AttributedString.Index(upper, within: out), from < to {
                out[from..<to].font = strong
            }
        }
        return out
    }
}

/// The thread a group of hits belongs to: its type glyph at the title's
/// weight, the title, the host trailing when there are several. The 12 pt
/// above is the air between groups; the row's top hairline is hidden so a
/// group starts on air, not a rule.
struct ThreadHeadRow: View {
    let head: SearchRow.ThreadHead
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            TypeGlyph(type: head.type, weight: .semibold)
            Text(head.title)
                .textStep(.title, weight: .semibold)
                .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
            Spacer(minLength: 8)
            if let host = head.host {
                Text(host)
                    .textStep(.stamp)
                    .lineLimit(1)
                    .layoutPriority(-1)
            }
        }
        .padding(.top, 12)
        .padding(.bottom, 4)
        .frame(minHeight: Layout.rowHeight)
        .accessibilityElement(children: .combine)
    }
}

/// A matching row: the snippet in the label color with the query's words
/// in weight, a notes glyph when the hit is in the thread's working notes,
/// and how long ago it was said, rolling as it ticks.
struct HitRow: View {
    let hit: SearchRow.Hit

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if hit.isNote {
                MetaGlyph("note.text", label: "Notes")
            }
            Text(MatchEmphasis.attributed(hit.snippet, matches: hit.matches, step: .meta))
                .foregroundStyle(.primary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 8)
            AgoText(hit.ts)
        }
        .padding(.vertical, 8)
        .frame(minHeight: Layout.rowHeight)
        .accessibilityElement(children: .combine)
    }
}

/// The project a group of file lines belongs to: the section band on the
/// chrome step, with the host trailing when there are several.
struct ProjectHeadRow: View {
    let head: SearchRow.ProjectHead

    var body: some View {
        SectionHeader(head.name, branch: head.branch, worktree: head.worktree) {
            if let host = head.host {
                Text(host)
                    .textStep(.stamp)
                    .lineLimit(1)
            }
        }
    }
}

/// A file line: a file glyph in the glyph column, the path with its line
/// number dim, the line itself in mono with the match in weight. The phone
/// has no editor, so the row is a fact, not a push.
struct FileRow: View {
    let file: SearchRow.FileHit
    @ScaledMetric(relativeTo: .subheadline) private var glyphWidth = Layout.glyphWidth

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            Image(systemName: "doc.text")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .frame(width: glyphWidth)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                (Text(file.relative) + Text(":\(file.line)").foregroundStyle(.tertiary))
                    .textStep(.meta)
                    .monospacedDigit()
                    .lineLimit(1)
                    .truncationMode(.head)
                Text(MatchEmphasis.attributed(file.preview, matches: file.matches, font: .caption.monospaced()))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
        }
        .padding(.vertical, 8)
        .frame(minHeight: Layout.rowHeight)
        .accessibilityElement(children: .combine)
    }
}

/// A project matched by name: a folder glyph, the name with the match in
/// weight, its branch and worktree mark, the host trailing when several.
/// A fact: the phone has no project screen to push.
struct ProjectRow: View {
    let project: SearchRow.ProjectHit
    @ScaledMetric(relativeTo: .subheadline) private var glyphWidth = Layout.glyphWidth

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            Image(systemName: "folder")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
                .frame(width: glyphWidth)
                .accessibilityHidden(true)
            Text(MatchEmphasis.attributed(project.name, matches: project.matches, step: .title))
                .foregroundStyle(.primary)
                .lineLimit(1)
            if project.worktree {
                MetaGlyph("arrow.triangle.pull", label: "Worktree")
            }
            if let branch = project.branch {
                Text(branch)
                    .textStep(.stamp)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            if let host = project.host {
                Text(host)
                    .textStep(.stamp)
                    .lineLimit(1)
                    .layoutPriority(-1)
            }
        }
        .padding(.vertical, 6)
        .frame(minHeight: Layout.rowHeight)
        .accessibilityElement(children: .combine)
    }
}

/// A host cut its answer short: one dim line after the last match.
struct MoreRow: View {
    var body: some View {
        Text("More matches than shown")
            .textStep(.stamp)
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
    }
}

/// What each host took, after the answer landed: "Mac 320 ms · box 1.2 s",
/// an offline or failed host named as such. Only with several hosts.
struct FootRow: View {
    let text: String

    var body: some View {
        Text(text)
            .textStep(.stamp)
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
            .accessibilityLabel("Search timing: \(text)")
    }
}

/// One calm line where the list has nothing to show: the hint before a
/// query, "No results" after one. Secondary, centered, no icon.
struct SearchStatusLine: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .textStep(.meta)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 32)
    }
}
