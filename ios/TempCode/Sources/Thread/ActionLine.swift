import SwiftUI
import TempCodeClient
import TempCodeContract

/// The one line every step of the agent's work draws, the desktop's
/// `ActionLine` on the step grid (transcript/stepLine.ts): the 14 pt glyph
/// slot, 8 pt to the verb in the secondary ink, the object in primary (it
/// truncates first), the counts 4 pt apart in tabular digits (+n in green,
/// −m in red, a todo tally muted, a failed count red), and the chevron 8 pt
/// after the last value, turning 90° over `base` when the row opens a body.
/// A slot with nothing to draw takes no room. 28 pt alone at the prose's
/// edge; 32 pt in a group's table, its words 12 pt in.
struct ActionLine: View {
    /// The glyph slot: the kind's symbol, or the running dot, or the failed mark.
    let glyph: ActionGlyph
    let verb: String
    var object = ""
    /// The object is a path: it truncates in the middle.
    var isFile = false
    var tally: String?
    var adds = 0
    var dels = 0
    var failed = 0
    /// The chevron: nil draws none; false points right, true turns down.
    var chevron: Bool?
    var inTable = false

    var body: some View {
        HStack(spacing: TranscriptMetrics.wordGap) {
            glyph
                .frame(width: TranscriptMetrics.glyphSlot, height: TranscriptMetrics.glyphSlot)
                .padding(.trailing, TranscriptMetrics.glyphGap - TranscriptMetrics.wordGap)
            if !verb.isEmpty {
                Text(verb)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize(horizontal: !object.isEmpty, vertical: false)
            }
            if !object.isEmpty {
                Text(object)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(isFile ? .middle : .tail)
                    .layoutPriority(-1)
            }
            StepCounts(tally: tally, adds: adds, dels: dels, failed: failed)
            if let chevron {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(chevron ? 90 : 0))
                    .animation(Motion.base, value: chevron)
                    .padding(.leading, TranscriptMetrics.afterValue - TranscriptMetrics.wordGap)
                    .accessibilityHidden(true)
            }
            Spacer(minLength: 0)
        }
        .transcriptType(TranscriptType.line)
        .padding(.horizontal, inTable ? TranscriptMetrics.tableInset : 0)
        .frame(height: inTable ? TranscriptMetrics.tableRow : TranscriptMetrics.line)
        .contentShape(Rectangle())
    }
}

/// `Counts`: what a line adds up to, tabular, nothing when there is nothing to say.
struct StepCounts: View {
    var tally: String?
    var adds = 0
    var dels = 0
    var failed = 0

    var body: some View {
        if tally != nil || adds > 0 || dels > 0 || failed > 0 {
            HStack(spacing: TranscriptMetrics.wordGap) {
                if let tally { Text(tally).foregroundStyle(.secondary) }
                if adds > 0 { Text("+\(adds)").foregroundStyle(Tint.success) }
                if dels > 0 { Text("−\(dels)").foregroundStyle(Tint.destructive) }
                if failed > 0 {
                    HStack(spacing: TranscriptMetrics.wordGap) {
                        Image(systemName: "xmark.circle.fill")
                            .imageScale(.small)
                        Text("\(failed)")
                    }
                    .foregroundStyle(Tint.destructive)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(failed) failed")
                }
            }
            .monospacedDigit()
            .fixedSize()
        }
    }
}

/// What a step's glyph slot holds. A running step is the still 6 pt dot:
/// the working line under the turn is the transcript's one moving mark.
struct ActionGlyph: View {
    enum Look: Equatable { case symbol(String), running, failed }
    let look: Look

    var body: some View {
        switch look {
        case .symbol(let name):
            Image(systemName: name)
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        case .running:
            Circle()
                .fill(.secondary)
                .frame(width: TranscriptMetrics.stepDot, height: TranscriptMetrics.stepDot)
                .accessibilityLabel("Working")
        case .failed:
            Image(systemName: "xmark")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Tint.destructive)
                .accessibilityLabel("Failed")
        }
    }
}

extension ActionRow {
    /// The row's glyph, by what it did; running and failed take the slot first.
    var look: ActionGlyph.Look {
        if failed { return .failed }
        if running { return .running }
        return .symbol(symbol)
    }

    /// The desktop's tool glyphs (lucide) in SF Symbols.
    var symbol: String {
        if agent { return "person.2" }
        switch glyph {
        case .delete: return "trash"
        case .app: return "square.grid.2x2"
        case .kind(let kind):
            switch kind {
            case .run: return "terminal"
            case .read: return "doc.text"
            case .list: return "folder"
            case .write: return "doc.badge.plus"
            case .edit, .patch: return "pencil.line"
            case .search, .glob: return "magnifyingglass"
            case .fetch, .web: return "globe"
            case .todo: return "checklist"
            case .question: return "questionmark.bubble"
            case .skill: return "sparkles"
            case .mcp: return connector == nil ? "wrench" : "puzzlepiece.extension"
            case .tool: return connector == nil ? "wrench" : "puzzlepiece.extension"
            }
        }
    }
}

extension ActivityGroup.Kind {
    /// The group line's glyph: the work it did most.
    var symbol: String {
        switch self {
        case .edit: "pencil.line"
        case .research: "magnifyingglass"
        case .run: "terminal"
        case .agents: "person.2"
        case .other: "wrench"
        case .think: "sparkles"
        }
    }
}
