import SwiftUI
import TempCodeClient

/// One of the app's notes matched by `notes.search`: the note glyph in the
/// glyph column at the title's weight, the title, the snippet with the
/// query's words in weight, the host trailing when there are several. A
/// fact, not a button: the phone has no note viewer. Nothing animates.
struct NoteRow: View {
    let note: SearchRow.NoteHit
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .subheadline) private var glyphWidth = Layout.glyphWidth

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
            MetaGlyph("note.text", label: "Note")
                .frame(width: glyphWidth)
            VStack(alignment: .leading, spacing: 2) {
                Text(note.title)
                    .textStep(.title)
                    .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                Text(MatchEmphasis.attributed(note.snippet, matches: note.matches, step: .meta))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 8)
            if let host = note.host {
                Text(host)
                    .textStep(.stamp)
                    .lineLimit(1)
                    .layoutPriority(-1)
            }
        }
        .padding(.vertical, 8)
        .frame(minHeight: Layout.rowHeight)
        .accessibilityElement(children: .combine)
    }
}
