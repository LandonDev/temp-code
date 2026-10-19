import SwiftUI
import TempCodeClient

/// The plan file as the page: generous measure, body size, streaming in as
/// it is written. Empty until the agent writes it.
struct PlanView: View {
    let sessionId: String
    let document: String?
    let running: Bool

    var body: some View {
        let text = document?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        ScrollView {
            if text.isEmpty {
                HStack(spacing: 8) {
                    Spacer()
                    if running {
                        ProgressView()
                            .controlSize(.small)
                        Text("Drafting the plan")
                    } else {
                        Text("No plan yet")
                    }
                    Spacer()
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.top, 40)
            } else {
                MarkdownView(seq: ThreadCaches.documentSeq(sessionId), text: document ?? "")
                    .textSelection(.enabled)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)
            }
        }
    }
}

struct ReportRoute: Hashable {
    let sessionId: String
    let title: String
    let body: String
}

/// A research report, opened from its pin.
struct ReportScreen: View {
    let route: ReportRoute

    var body: some View {
        ScrollView {
            MarkdownView(seq: ThreadCaches.documentSeq(route.sessionId) - 1, text: route.body)
                .textSelection(.enabled)
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
        }
        .background(Surface.background)
        .navigationTitle(route.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

extension ThreadCaches {
    /// A negative seq for a thread's document, so it caches beside the rows.
    static func documentSeq(_ sessionId: String) -> Int {
        -2 - abs(sessionId.hashValue % 1_000_000) * 2
    }
}
