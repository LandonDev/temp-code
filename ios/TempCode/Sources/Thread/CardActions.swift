import SwiftUI
import TempCodeClient
import TempCodeContract

// The actions at the bottom of the live cards. The cards' rendering lives
// in TranscriptRows.swift; what the person does with them lives here: the
// full-width buttons, the optimistic decision the client shows before the
// host answers, the one quiet line a refusal leaves behind, the light tap
// on a decision. A key that cannot act sees the reason in the buttons'
// place; a link that is only down for a moment sees the buttons dimmed
// with the reason under them.

/// Allow and Deny under an approval. Allow is the prominent one, in the
/// accent; Deny is quiet. A decision shows at once (the client records it
/// before the wire) and the card settles in 200 ms ease-out when the
/// buttons leave; a refusal rolls the decision back and says so in one
/// quiet line that the next decision clears.
struct ApprovalActions: View {
    let approval: ApprovalItem
    let client: EnvironmentClient
    let sessionId: String
    @State private var busy: Bool? = nil
    @State private var failure: String?
    @State private var decidedCount = 0

    var body: some View {
        let block = client.approveBlock
        VStack(alignment: .leading, spacing: 8) {
            if let block, !block.isTransient {
                blockLine(block)
            } else {
                CardButton("Allow", role: .prominent, busy: busy == true) { decide(true) }
                    .disabled(busy != nil || block != nil)
                    .opacity(block == nil ? 1 : 0.5)
                    .accessibilityHint("Let the agent run this")
                CardButton("Deny", role: .quiet, busy: busy == false) { decide(false) }
                    .disabled(busy != nil || block != nil)
                    .opacity(block == nil ? 1 : 0.5)
                    .accessibilityHint("Refuse this")
                if let block {
                    blockLine(block)
                }
            }
            if let failure {
                QuietLine(symbol: "arrow.uturn.backward", text: failure)
                    .transition(.opacity)
            }
        }
        .animation(Motion.crossFade, value: failure)
        .animation(Motion.crossFade, value: block == nil)
        .sensoryFeedback(.impact(weight: .light), trigger: decidedCount)
    }

    private func blockLine(_ block: ActionBlock) -> some View {
        Text(block.text(now: Date().timeIntervalSince1970 * 1000))
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
    }

    private func decide(_ allow: Bool) {
        guard busy == nil else { return }
        busy = allow
        failure = nil
        decidedCount += 1
        Task {
            defer { busy = nil }
            do {
                try await client.approve(sessionId, requestId: approval.request.requestId, allow: allow)
            } catch {
                let reason = (error as? ActionError)?.message ?? String(describing: error)
                failure = "\(allow ? "Not allowed" : "Not denied"): \(reason)"
            }
        }
    }
}

/// Answer under a question: one prominent button that sends every
/// question's choice (or typed text) at once, off until each has one. The
/// answers show as chosen the moment they go; a refusal rolls them back
/// with one quiet line.
struct QuestionActions: View {
    let question: QuestionItem
    let client: EnvironmentClient
    let sessionId: String
    /// Every question's answer as the card has it so far: chosen labels, or the typed text.
    let answers: [[String]]
    /// Every question has a choice or typed text.
    let complete: Bool
    @State private var busy = false
    @State private var failure: String?
    @State private var sentCount = 0

    var body: some View {
        let block = client.operateBlock
        VStack(alignment: .leading, spacing: 8) {
            if let block, !block.isTransient {
                blockLine(block)
            } else {
                CardButton("Answer", role: .prominent, busy: busy) { submit() }
                    .disabled(busy || block != nil || !complete)
                    .opacity((complete || busy) && block == nil ? 1 : 0.5)
                    .animation(Motion.crossFade, value: complete)
                if let block {
                    blockLine(block)
                }
            }
            if let failure {
                QuietLine(symbol: "arrow.uturn.backward", text: failure)
                    .transition(.opacity)
            }
        }
        .animation(Motion.crossFade, value: failure)
        .animation(Motion.crossFade, value: block == nil)
        .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
    }

    private func blockLine(_ block: ActionBlock) -> some View {
        Text(block.text(now: Date().timeIntervalSince1970 * 1000))
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 4)
    }

    private func submit() {
        guard !busy, complete else { return }
        busy = true
        failure = nil
        sentCount += 1
        let set = answers
        Task {
            defer { busy = false }
            do {
                try await client.answer(sessionId, requestId: question.request.requestId, answers: set)
            } catch {
                let reason = (error as? ActionError)?.message ?? String(describing: error)
                failure = "Not answered: \(reason)"
            }
        }
    }
}
