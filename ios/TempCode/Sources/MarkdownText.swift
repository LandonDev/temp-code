import SwiftUI
import TempCodeClient
import TempCodeContract

/// The agent's prose: paragraphs with inline markdown, headings, lists and
/// fenced code, each its own block so code never wraps as prose.
struct MarkdownText: View {
    let text: String

    var body: some View {
        let blocks = MarkdownBlocks.split(text)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .paragraph(let p):
                    Text(MarkdownBlocks.inline(p))
                case .heading(let level, let h):
                    Text(MarkdownBlocks.inline(h))
                        .font(level <= 1 ? .title3.weight(.semibold) : .headline)
                        .padding(.top, 4)
                case .list(let items, let ordered):
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(ordered ? "\(index + 1)." : "•")
                                    .foregroundStyle(.secondary)
                                    .frame(minWidth: 14, alignment: .trailing)
                                Text(MarkdownBlocks.inline(item))
                            }
                        }
                    }
                case .code(let code, _):
                    CodeBlock(text: code, maxLines: 40)
                case .quote(let q):
                    Text(MarkdownBlocks.inline(q))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 12)
                        .overlay(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 1)
                                .fill(.quaternary)
                                .frame(width: 2)
                        }
                case .rule:
                    Divider()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Monospaced text in a quiet well; long output folds past `maxLines`.
struct CodeBlock: View {
    let text: String
    var maxLines = 20
    var tint: Color?
    @State private var expanded = false

    var body: some View {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        let shown = expanded ? lines : Array(lines.prefix(maxLines))
        VStack(alignment: .leading, spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(shown.joined(separator: "\n"))
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(tint ?? .primary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
            }
            if lines.count > maxLines {
                Button(expanded ? "Show less" : "Show all \(lines.count) lines") {
                    withAnimation(.spring(duration: 0.3, bounce: 0)) { expanded.toggle() }
                }
                .font(.caption.weight(.medium))
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemFill).opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// A file edit as the desktop shows it: additions and deletions, line
/// numbers, context between.
struct DiffView: View {
    let lines: [TempCodeContract.ToolPreview.Line]
    var additions: Double?
    var deletions: Double?
    @State private var expanded = false

    var body: some View {
        let shown = expanded ? lines : Array(lines.prefix(30))
        VStack(alignment: .leading, spacing: 6) {
            if additions != nil || deletions != nil {
                HStack(spacing: 8) {
                    if let additions, additions > 0 { Text("+\(Int(additions))").foregroundStyle(.green) }
                    if let deletions, deletions > 0 { Text("−\(Int(deletions))").foregroundStyle(.red) }
                }
                .font(.caption.weight(.medium).monospacedDigit())
            }
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(shown.enumerated()), id: \.offset) { _, line in
                        HStack(spacing: 8) {
                            Text(line.number.map { String(Int($0)) } ?? "")
                                .foregroundStyle(.tertiary)
                                .frame(width: 34, alignment: .trailing)
                            Text(marker(line.kind) + line.text)
                                .foregroundStyle(color(line.kind))
                        }
                        .font(.system(.footnote, design: .monospaced))
                        .padding(.vertical, 1)
                        .padding(.horizontal, 6)
                        .background(background(line.kind))
                    }
                }
                .fixedSize(horizontal: true, vertical: false)
            }
            if lines.count > 30 {
                Button(expanded ? "Show less" : "Show all \(lines.count) lines") {
                    withAnimation(.spring(duration: 0.3, bounce: 0)) { expanded.toggle() }
                }
                .font(.caption.weight(.medium))
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemFill).opacity(0.6), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func marker(_ kind: TempCodeContract.ToolPreview.Line.Kind) -> String {
        switch kind {
        case .add: "+ "
        case .del: "− "
        default: "  "
        }
    }

    private func color(_ kind: TempCodeContract.ToolPreview.Line.Kind) -> Color {
        switch kind {
        case .add: .green
        case .del: .red
        default: .primary
        }
    }

    private func background(_ kind: TempCodeContract.ToolPreview.Line.Kind) -> Color {
        switch kind {
        case .add: Color.green.opacity(0.12)
        case .del: Color.red.opacity(0.12)
        default: .clear
        }
    }
}
