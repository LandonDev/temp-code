import SwiftUI
import TempCodeClient
import TempCodeContract

/// The row a failed turn ends on, the desktop's FailureCard recipe: a card
/// at radius 8, 12 in, the summary in the line type at medium beside the red
/// glyph, the likely cause muted 2 pt under it, and at most three actions
/// this key can take on the summary's text edge, each sized to its label:
/// the first solid, the rest quiet, Retry last. Continue on another model
/// opens the composer's model menu and continues on the pick
/// (`session.continue` with the model). The words are the host's
/// (failureKind.ts); nothing here reads the error text.
struct FailureCard: View {
    let line: SystemLine
    let failure: Failure
    let client: EnvironmentClient
    let sessionId: String
    @State private var pending: FailureAction.ID?
    @State private var outcome: String?
    @State private var outcomeIsError = false
    /// The composer's catalog, for Continue on another model.
    @State private var choice = CatalogChoice(provider: .claude, model: "", reasoning: nil)
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
        // Another model needs the thread's own model to start the menu from.
        let actions = FailureActions.actions(kind: failure.kind, routed: routed, roomElsewhere: failure.roomElsewhere)
            .filter { $0.id != .pickModel || client.session(sessionId) != nil }
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
                Group {
                    if let block, !block.isTransient {
                        Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                            .transcriptType(TranscriptType.line)
                            .foregroundStyle(.secondary)
                    } else {
                        // Side by side while every label fits on one line, else stacked; each as wide as its label.
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: TranscriptMetrics.glyphGap) { actionButtons(actions) }
                            VStack(alignment: .leading, spacing: TranscriptMetrics.glyphGap) { actionButtons(actions) }
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
        .task {
            guard actions.contains(where: { $0.id == .pickModel }) else { return }
            await choice.load(client)
            if let session = client.session(sessionId) { choice.follow(session) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(failure.summary)
    }

    @ViewBuilder
    private func actionButtons(_ actions: [FailureAction]) -> some View {
        ForEach(Array(actions.enumerated()), id: \.element.id) { index, action in
            if action.id == .pickModel {
                // The composer's model menu; the pick continues the thread on it.
                ModelMenu(choice: choice, onPick: continueOn) {
                    Text(label(action)).lineLimit(1)
                }
                .menuStyle(.button)
                .failureAction(solid: index == 0)
                .disabled(choice.catalog == nil)
            } else {
                Button { act(action.id) } label: {
                    Text(label(action)).lineLimit(1)
                }
                .failureAction(solid: index == 0)
            }
        }
    }

    private func label(_ action: FailureAction) -> String {
        pending == action.id ? FailureActions.pendingLabel(action.id) : action.label
    }

    private func act(_ id: FailureAction.ID) {
        guard pending == nil, id != .pickModel else { return }
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
                case .pickModel:
                    break // the menu's pick runs `continueOn`
                }
            } catch {
                settle(error)
            }
        }
    }

    /// Continue on another model: the thread continues on the pick (a pick of
    /// its own model is a plain continue).
    private func continueOn(_ key: ModelKey) {
        guard pending == nil else { return }
        pending = .pickModel
        outcome = nil
        outcomeIsError = false
        let model = client.session(sessionId).flatMap { TurnModel.override(for: $0, provider: key.provider, model: key.model, reasoning: choice.reasoning) }
        Task {
            do {
                try await client.continueThread(sessionId, model: model)
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

private extension View {
    /// The card's first action is solid; the rest are quiet, in the label colour.
    @ViewBuilder
    func failureAction(solid: Bool) -> some View {
        if solid {
            buttonStyle(.borderedProminent)
        } else {
            buttonStyle(.bordered).tint(.primary)
        }
    }
}
