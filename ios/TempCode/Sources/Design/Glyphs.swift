import SwiftUI
import TempCodeContract

/// The desktop's thread type glyphs, labels and tints
/// (src/renderer/src/surfaces/threads/bits.tsx) in SF Symbols, and the
/// fleet's agent glyphs. Outline is the default; fill marks the active state.
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

/// A thread's type, tinted; the stroke follows the weight of the title beside it.
struct TypeGlyph: View {
    let type: ThreadType?
    var weight: Font.Weight = .regular

    var body: some View {
        let type = type ?? .chat
        Image(systemName: type.symbol)
            .font(.subheadline.weight(weight))
            .foregroundStyle(type.tint)
            .frame(width: 20)
            .accessibilityLabel(type.label)
    }
}

/// A subagent's role, in the tertiary step so the root's tint stays the loud one.
struct AgentGlyph: View {
    let type: AgentType

    var body: some View {
        Image(systemName: type.symbol)
            .font(.subheadline)
            .foregroundStyle(.tertiary)
            .frame(width: 20)
            .accessibilityLabel(type.label)
    }
}
