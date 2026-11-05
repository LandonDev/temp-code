import SwiftUI
import TempCodeClient
import TempCodeContract

/// The row a failed turn ends on, the desktop's FailureCard recipe: a card
/// at radius 8, 12 in, the summary in the line type at medium beside the red
/// glyph, the likely cause muted 2 pt under it, the note naming what only
/// the desktop can do, and at most three actions this key can take, Retry
/// last, everything under the summary on its text edge. The words are the host's
/// (failureKind.ts); nothing here reads the error text.
struct FailureCard: View {
    let line: SystemLine
    let failure: Failure
    let client: EnvironmentClient
    let sessionId: String
    @State private var pending: FailureAction.ID?
    @State private var outcome: String?
    @State private var outcomeIsError = false
    /// The cause sits 2 pt under the summary (the desktop's `mt-0.5`).
    private static let causeGap: CGFloat = 2

    /// Where the thread's accounts come from: Meta's keys for a Meta row. A
    /// thread this client cannot see is unrouted: Retry alone, no account note.
    private var routed: RoutedProvider? {
        client.session(sessionId).flatMap { RoutedProvider(provider: $0.provider, model: $0.model, catalog: client.catalog) }
    }
    /// The thread is working again: the buttons rest.
    private var busy: Bool { Fleet.isLive(client.session(sessionId)?.status ?? .idle) }

    var body: some View {
        let busy = busy
        let block = client.operateBlock
        let actions = FailureActions.actions(kind: failure.kind, routed: routed, roomElsewhere: failure.roomElsewhere)
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: TranscriptMetrics.glyphGap) {
                Image(systemName: "exclamationmark.triangle")
                    .transcriptFont(TranscriptType.line, weight: .medium)
                    .foregroundStyle(Tint.destructive)
                    .frame(width: TranscriptMetrics.glyphSlot)
                Text(failure.summary)
                    .transcriptType(TranscriptType.line, weight: .medium)
                    .lineLimit(3)
            }
            // Everything under the summary hangs on its text edge, as the desktop's `pl-5.5`.
            VStack(alignment: .leading, spacing: 0) {
                Text(failure.cause)
                    .transcriptType(TranscriptType.line)
                    .foregroundStyle(.secondary)
                    .padding(.top, Self.causeGap)
                if let note = FailureActions.note(kind: failure.kind, routed: routed, roomElsewhere: failure.roomElsewhere) {
                    Text(note)
                        .transcriptType(TranscriptType.detail)
                        .foregroundStyle(.secondary)
                        .padding(.top, TranscriptMetrics.wordGap)
                }
                Group {
                    if let block, !block.isTransient {
                        Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                            .transcriptType(TranscriptType.line)
                            .foregroundStyle(.secondary)
                    } else {
                        // Side by side while every label fits on one line, else stacked full width.
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: TranscriptMetrics.glyphGap) { actionButtons(actions) }
                            VStack(spacing: TranscriptMetrics.glyphGap) { actionButtons(actions) }
                        }
                        .controlSize(.small)
                        .disabled(busy || pending != nil || block != nil)
                        if let block {
                            Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                                .transcriptType(TranscriptType.line)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding(.top, TranscriptMetrics.Gap.block)
                if let outcome {
                    Text(outcome)
                        .transcriptType(TranscriptType.detail)
                        .foregroundStyle(outcomeIsError ? Tint.destructive : Color.secondary)
                        .padding(.top, TranscriptMetrics.glyphGap)
                }
            }
            .padding(.leading, TranscriptMetrics.glyphSlot + TranscriptMetrics.glyphGap)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(TranscriptMetrics.tableInset)
        .background(Surface.chrome, in: .rowCorner)
        .hairlineBorder(RoundedRectangle.rowCorner)
        .animation(Motion.crossFade, value: outcome)
        .onChange(of: busy) { _, now in
            if now { pending = nil }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(failure.summary)
    }

    @ViewBuilder
    private func actionButtons(_ actions: [FailureAction]) -> some View {
        ForEach(actions) { action in
            if action.id == .retry {
                Button { act(action.id) } label: {
                    Text(label(action)).lineLimit(1).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            } else {
                Button { act(action.id) } label: {
                    Text(label(action)).lineLimit(1).frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private func label(_ action: FailureAction) -> String {
        pending == action.id ? FailureActions.pendingLabel(action.id) : action.label
    }

    private func act(_ id: FailureAction.ID) {
        guard pending == nil else { return }
        pending = id
        outcome = nil
        outcomeIsError = false
        Task {
            do {
                switch id {
                case .retry:
                    try await client.continueThread(sessionId)
                case .route:
                    let answer = try await client.reroute(sessionId)
                    guard answer.moved else {
                        say("No other account has room right now.")
                        pending = nil
                        return
                    }
                    if let account = answer.account { say("Now on \(account)") }
                    pending = .retry
                    try await client.continueThread(sessionId)
                }
            } catch {
                settle(error)
            }
        }
    }

    /// The call failed: the buttons come back with the reason under them.
    private func settle(_ error: any Error) {
        pending = nil
        outcomeIsError = true
        say((error as? ActionError)?.message ?? "That did not work.")
    }

    /// The outcome line, read out as well as shown.
    private func say(_ text: String) {
        outcome = text
        AccessibilityNotification.Announcement(text).post()
    }
}
