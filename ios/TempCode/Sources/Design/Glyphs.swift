import SwiftUI
import TempCodeContract

/// The desktop's thread type glyphs, labels and tints
/// (src/renderer/src/surfaces/threads/bits.tsx) in SF Symbols, and the
/// fleet's agent glyphs. Outline is the default; fill marks the active
/// state. A glyph's stroke follows the weight of the text beside it (the
/// symbol weight is the stroke), and its size follows Dynamic Type with
/// that text.
extension ThreadType {
    nonisolated var symbol: String {
        switch self {
        case .chat: "bubble.left"
        case .planning: "map"
        case .projectPlan: "flag.checkered"
        case .implementation: "checklist"
        case .orchestration: "arrow.triangle.branch"
        case .research: "binoculars"
        case .unknown: "bubble.left"
        }
    }

    /// The filled variant, for the active state (the selected segment, the open thread's chip).
    nonisolated var filledSymbol: String {
        switch self {
        case .chat, .unknown: "bubble.left.fill"
        case .planning: "map.fill"
        case .implementation: "checklist.checked"
        case .orchestration: "arrow.triangle.branch"
        case .research: "binoculars.fill"
        }
    }

    nonisolated var label: String {
        switch self {
        case .chat: "Chat"
        case .planning: "Plan"
        case .projectPlan: "Project plan"
        case .implementation: "Implement"
        case .orchestration: "Orchestrate"
        case .research: "Research"
        case .unknown(let value): value.prefix(1).uppercased() + value.dropFirst()
        }
    }

    /// The desktop's one-line hint per type (THREAD_HINTS in bits.tsx).
    nonisolated var hint: String {
        switch self {
        case .chat: "Ask questions, explore the code"
        case .planning: "Produce a plan document to implement from"
        case .projectPlan: "Survey the whole project, lay out its milestones"
        case .implementation: "Execute a task, todos in focus"
        case .orchestration: "Spawn and direct subagents"
        case .research: "Investigate with parallel explorers, produce a cited report"
        case .unknown: ""
        }
    }

    var tint: Color {
        switch self {
        case .chat: Tint.info
        case .planning: Tint.violet
        case .projectPlan: Tint.violet
        case .implementation: Tint.success
        case .orchestration: Tint.warning
        case .research: Tint.cyan
        case .unknown: Color(.secondaryLabel)
        }
    }
}

extension AgentType {
    nonisolated var symbol: String {
        switch self {
        case .orchestrator: "person.2"
        case .implementer: "wrench"
        case .reviewer: "checklist"
        case .explorer: "magnifyingglass"
        case .unknown: "person"
        }
    }

    nonisolated var label: String {
        switch self {
        case .orchestrator: "Orchestrator"
        case .implementer: "Implementer"
        case .reviewer: "Reviewer"
        case .explorer: "Explorer"
        case .unknown(let value): value.prefix(1).uppercased() + value.dropFirst()
        }
    }
}

/// A thread's type, tinted, in the glyph column. `weight` is the weight of
/// the title beside it; `active` swaps in the fill, and the caller changes
/// it inside `withAnimation(Motion.crossFade)` for the 150 ms swap. (This
/// file also builds into the Live Activity extension, which has no Motion.)
struct TypeGlyph: View {
    let type: ThreadType?
    var weight: Font.Weight = .regular
    var active = false
    @ScaledMetric(relativeTo: .subheadline) private var width = Layout.glyphWidth

    var body: some View {
        let type = type ?? .chat
        Image(systemName: active ? type.filledSymbol : type.symbol)
            .font(.subheadline.weight(weight))
            .foregroundStyle(type.tint)
            .frame(width: width)
            .contentTransition(.symbolEffect(.replace))
            .accessibilityLabel(type.label)
    }
}

/// A subagent's role in the glyph column, in the tertiary step so the
/// root's tint stays the loud one. `weight` is the weight of the title beside it.
struct AgentGlyph: View {
    let type: AgentType
    var weight: Font.Weight = .regular
    @ScaledMetric(relativeTo: .subheadline) private var width = Layout.glyphWidth

    var body: some View {
        Image(systemName: type.symbol)
            .font(.subheadline.weight(weight))
            .foregroundStyle(.tertiary)
            .frame(width: width)
            .accessibilityLabel(type.label)
    }
}

/// A glyph beside meta text (a branch, a worktree, a host): footnote size,
/// the text's weight, the text's color unless a tint is given.
struct MetaGlyph: View {
    let systemName: String
    var weight: Font.Weight = .regular
    var tint: Color?
    var label: String

    init(_ systemName: String, weight: Font.Weight = .regular, tint: Color? = nil, label: String) {
        self.systemName = systemName
        self.weight = weight
        self.tint = tint
        self.label = label
    }

    var body: some View {
        Image(systemName: systemName)
            .font(.footnote.weight(weight))
            .imageScale(.small)
            .foregroundStyle(tint.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.tertiary))
            .accessibilityLabel(label)
    }
}
