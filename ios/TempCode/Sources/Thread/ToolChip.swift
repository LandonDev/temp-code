import SwiftUI
import TempCodeClient
import TempCodeContract

/// A quiet placeholder of the body's final height while it is fetched.
struct Shimmer: View {
    let height: CGFloat
    @State private var phase: CGFloat = -1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        RoundedRectangle.rowCorner
            .fill(TranscriptStyle.control)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .overlay {
                if !reduceMotion {
                    GeometryReader { proxy in
                        LinearGradient(colors: [.clear, Surface.background.opacity(0.35), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: proxy.size.width * 0.6)
                            .offset(x: phase * proxy.size.width)
                    }
                    .clipShape(.rowCorner)
                    // The sweep rides on the gradient alone, never on the row's layout.
                    .animation(.linear(duration: 1.2).repeatForever(autoreverses: false), value: phase)
                }
            }
            .onAppear {
                guard !reduceMotion else { return }
                phase = 1
            }
            .accessibilityLabel("Loading")
    }
}

extension ToolItem {
    var chipKind: ActivityKind { Board.actKind(self) }

    /// What a plan-tool call did, in one quiet line.
    var planLine: String {
        switch name {
        case "TodoWrite", "update_plan":
            if let count = BoardState.todos(from: name, input: input)?.count { return "Updated the task list (\(count) \(count == 1 ? "task" : "tasks"))" }
            return "Updated the task list"
        case "TaskCreate":
            if let subject = input?["subject"]?.stringValue, !subject.isEmpty { return "New task: \(subject)" }
            return "New task"
        case "TaskUpdate":
            let id = input?["taskId"]?.stringValue ?? input?["taskId"]?.intValue.map(String.init) ?? ""
            let status = (input?["status"]?.stringValue ?? "").replacingOccurrences(of: "_", with: " ")
            return "Task \(id.isEmpty ? "" : "#\(id) ")\(status)".trimmingCharacters(in: .whitespaces)
        default:
            return "Read the task list"
        }
    }

    /// The desktop's activity icons (`ActivityPhaseIcon`, lucide) in SF Symbols.
    var chipGlyph: String {
        switch chipKind {
        case .edit: "pencil.line"
        case .read: "doc.text"
        case .search: "magnifyingglass"
        case .command: "terminal"
        case .subagent: "person.2"
        case .web: "globe"
        case .tool: display?.app != nil ? "puzzlepiece.extension" : "wrench"
        }
    }

    /// The verb: what the tool did, in a word (the board's rows).
    var chipVerb: String { phrase.verb }

    /// The target: a file, a pattern, a query (the board's rows).
    var chipTarget: String? { phrase.target }
}
