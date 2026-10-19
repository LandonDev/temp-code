import SwiftUI
import TempCodeClient
import TempCodeContract

struct DiffRoute: Hashable {
    let sessionId: String
    let card: ChangeCard
}

/// The whole change to one file, unified: mono, line numbers dim, adds and
/// deletes tinted. Lines the host kept are fetched when the screen opens.
struct DiffScreen: View {
    let client: EnvironmentClient
    let route: DiffRoute
    @State private var lines: [ToolPreview.Line]?
    @State private var missing = false

    var body: some View {
        Group {
            if let lines {
                DiffLines(lines: lines)
            } else if missing {
                ContentUnavailableView("No diff", systemImage: "doc.text", description: Text("This edit left no lines to show."))
            } else {
                ProgressView()
            }
        }
        .background(Surface.background)
        .navigationTitle(route.card.fileName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ChangeStat(adds: route.card.adds, dels: route.card.dels)
            }
        }
        .task(id: route.card.id) { await load() }
    }

    private func load() async {
        if let whole = route.card.lines {
            lines = whole
            missing = whole.isEmpty
            return
        }
        var out: [ToolPreview.Line] = []
        for edit in route.card.edits {
            if case .array(let held)? = edit.preview?.lines {
                out += held
            } else if let row = await client.body(sessionId: route.sessionId, seq: edit.seq), case .toolCall(let call) = row.event, case .array(let fetched)? = call.preview?.lines {
                out += fetched
            }
        }
        lines = out.isEmpty ? nil : out
        missing = out.isEmpty
    }
}

struct DiffLines: View {
    let lines: [ToolPreview.Line]
    var cap = 1_500
    @State private var expanded = false

    var body: some View {
        let shown = expanded ? lines : Array(lines.prefix(cap))
        ScrollView([.vertical, .horizontal]) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(shown.enumerated()), id: \.offset) { _, line in
                    DiffLineRow(line: line)
                }
                if lines.count > cap, !expanded {
                    Button("Show all \(lines.count) lines") { expanded = true }
                        .font(.footnote.weight(.medium))
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.accentColor)
                        .padding(12)
                }
            }
            .padding(.vertical, 8)
        }
    }
}

private struct DiffLineRow: View {
    let line: ToolPreview.Line

    var body: some View {
        HStack(spacing: 0) {
            Text(line.number.map { String(Int($0)) } ?? "")
                .foregroundStyle(.tertiary)
                .frame(width: 44, alignment: .trailing)
            Text(marker)
                .foregroundStyle(markerColor)
                .frame(width: 18)
            Text(line.text)
            Spacer(minLength: 16)
        }
        .font(.system(.footnote, design: .monospaced))
        .monospacedDigit()
        .padding(.vertical, 1)
        .padding(.trailing, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background)
    }

    private var marker: String {
        switch line.kind {
        case .add: "+"
        case .del: "−"
        default: " "
        }
    }

    private var markerColor: Color {
        switch line.kind {
        case .add: Tint.success
        case .del: Tint.destructive
        default: Color(.tertiaryLabel)
        }
    }

    private var background: Color {
        switch line.kind {
        case .add: Tint.success.opacity(0.12)
        case .del: Tint.destructive.opacity(0.12)
        default: .clear
        }
    }
}
