import SwiftUI
import TempCodeClient
import TempCodeContract

/// The row a failed turn ends on, with the host's verdict: what happened,
/// the likely cause, the note naming what only the desktop can do, and the
/// actions this key can take, Retry last. The words are the host's
/// (failureKind.ts); nothing here reads the error text.
struct FailureCard: View {
    let line: SystemLine
    let failure: Failure
    let client: EnvironmentClient
    let sessionId: String
    @State private var pending: FailureAction.ID?
    @State private var outcome: String?
    @State private var outcomeIsError = false

    /// A thread this client cannot see is unrouted: Retry alone, no account note.
    private var provider: ProviderId { client.session(sessionId)?.provider ?? .unknown("") }
    /// The thread is working again: the buttons rest.
    private var busy: Bool { Fleet.isLive(client.session(sessionId)?.status ?? .idle) }

    var body: some View {
        let busy = busy
        let block = client.operateBlock
        let actions = FailureActions.actions(kind: failure.kind, provider: provider)
        ThreadCard(tinted: !busy) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Tint.destructive)
                    Text(failure.summary)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(3)
                }
                Text(failure.cause)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let note = FailureActions.note(kind: failure.kind, provider: provider) {
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let block, !block.isTransient {
                    Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    HStack(spacing: 8) {
                        ForEach(actions) { action in
                            if action.id == .retry {
                                Button { act(action.id) } label: {
                                    Text(label(action)).frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.borderedProminent)
                            } else {
                                Button { act(action.id) } label: {
                                    Text(label(action)).frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                    .controlSize(.regular)
                    .disabled(busy || pending != nil || block != nil)
                    if let block {
                        Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                if let outcome {
                    Text(outcome)
                        .font(.footnote)
                        .foregroundStyle(outcomeIsError ? Tint.destructive : Color.secondary)
                }
            }
        }
        .animation(Motion.crossFade, value: outcome)
        .onChange(of: busy) { _, now in
            if now { pending = nil }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(failure.summary)
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
