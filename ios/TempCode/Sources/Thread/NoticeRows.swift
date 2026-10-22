import SwiftUI
import TempCodeClient
import TempCodeContract

/// The host's own row, by the notice's kind: a card for a review or a gate,
/// one quiet line for the rest. The plain kinds keep the host's words.
struct NoticeRow: View {
    let line: SystemLine
    let client: EnvironmentClient
    let sessionId: String

    var body: some View {
        if let notice = line.notice {
            switch notice.noticeKind {
            case .review:
                if let review = notice.review {
                    ReviewCard(review: review, resolved: line.reviewResolved, client: client, sessionId: sessionId)
                } else {
                    QuietLine(symbol: "checklist", text: notice.message)
                }
            case .gate:
                if let gate = notice.gate {
                    GateCard(gate: gate)
                } else {
                    QuietLine(symbol: "checkmark.seal", text: notice.message)
                }
            case .batch:
                BatchLine(message: notice.message)
            case .accountGone:
                AccountGoneLine(message: notice.message)
            case .other:
                QuietLine(symbol: "info.circle", text: notice.message)
            }
        } else {
            QuietLine(symbol: "info.circle", text: line.text)
        }
    }
}

// MARK: - review

/// The merge review's outcome: lead and detail on one line, the blocking
/// findings as rows, the minor ones folded, the reviewer thread one chip
/// away, and Merge anyway while the hold stands. A plain row, not a raised
/// surface: only an approval or a question is raised.
struct ReviewCard: View {
    let review: ReviewNotice
    let resolved: Bool
    let client: EnvironmentClient
    let sessionId: String
    @State private var minorOpen = false
    @State private var confirming = false
    @State private var busy = false
    @State private var failure: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var held: Bool { ReviewText.isHeld(review, resolved: resolved) }

    var body: some View {
        let held = held
        let block = client.approveBlock
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: symbol)
                    .font(held ? .footnote.weight(.medium) : .footnote)
                    .foregroundStyle(tint)
                    .frame(width: 16)
                (Text(ReviewText.lead(review, label: ModelName.short(review.model)))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(held ? Color.primary : Color.secondary)
                 + Text(detailSuffix)
                    .font(.subheadline)
                    .foregroundStyle(held ? Color.secondary : Color(.tertiaryLabel)))
                    .lineLimit(2)
                Spacer(minLength: 8)
                if let reviewerId = review.reviewerId, client.session(reviewerId) != nil {
                    ReviewerChip(reviewerId: reviewerId)
                }
            }
            ForEach(Array(review.blocking.enumerated()), id: \.offset) { _, finding in
                ReviewFindingRow(finding: finding, strong: held)
            }
            if !review.minor.isEmpty {
                FoldLine(open: $minorOpen, label: ReviewText.minorLine(review.minor.count))
                if minorOpen {
                    ForEach(Array(review.minor.enumerated()), id: \.offset) { _, finding in
                        ReviewFindingRow(finding: finding, strong: false)
                    }
                    .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
                }
            }
            if held {
                if let block, !block.isTransient {
                    Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    Button { confirming = true } label: {
                        Text(busy ? "Merging…" : "Merge anyway").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.regular)
                    .disabled(busy || block != nil)
                    .confirmationDialog(ReviewText.confirmTitle(review), isPresented: $confirming, titleVisibility: .visible) {
                        Button("Merge anyway") { merge() }
                    }
                    if let failure {
                        Text(failure)
                            .font(.footnote)
                            .foregroundStyle(Tint.destructive)
                    } else if let block {
                        Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Address the findings and merge again, or merge past them.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.horizontal, 8)
        .animation(reduceMotion ? nil : Motion.collapse, value: held)
        .animation(Motion.crossFade, value: failure)
        .accessibilityElement(children: .contain)
    }

    private var detailSuffix: String {
        let detail = ReviewText.detail(review, resolved: resolved)
        return detail.isEmpty ? "" : " · \(detail)"
    }

    private var symbol: String {
        if held { return "exclamationmark.triangle" }
        switch review.outcome {
        case .pass, .skipped, .mergedAnyway, .held: return "checkmark"
        case .timeout, .failed, .unknown: return "circle.dashed"
        }
    }

    private var tint: Color {
        if held { return Tint.destructive }
        switch review.outcome {
        case .pass, .skipped, .mergedAnyway, .held: return Tint.success
        case .timeout, .failed, .unknown: return Color(.secondaryLabel)
        }
    }

    private func merge() {
        guard !busy else { return }
        busy = true
        failure = nil
        // A green call stays busy until the host's merged-anyway row resolves the hold.
        Task {
            do {
                try await client.mergeAnyway(sessionId, runId: review.runId)
            } catch {
                busy = false
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }
}

/// One finding: the place in mono, the claim, and the failure scenario
/// under the thumb. The row is a button only when there is a scenario to show.
struct ReviewFindingRow: View {
    let finding: ReviewFinding
    let strong: Bool
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var scale

    private var hasScenario: Bool { !finding.failure_scenario.isEmpty }

    var body: some View {
        Button {
            withAnimation(reduceMotion ? Motion.crossFade : (open ? Motion.collapse : Motion.expand)) { open.toggle() }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(ReviewText.location(finding))
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(Surface.fill, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                    if finding.verdict == .plausible {
                        Text("plausible")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    Text(finding.summary)
                        .font(.subheadline)
                        .foregroundStyle(strong ? .primary : .secondary)
                    Spacer(minLength: 0)
                    if hasScenario {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                }
                if open {
                    Text(finding.failure_scenario)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
                }
            }
            .padding(.leading, 10)
            .overlay(alignment: .leading) { Rectangle().fill(Surface.hairline).frame(width: 1 / scale) }
            .frame(minHeight: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .disabled(!hasScenario)
        .accessibilityLabel("\(ReviewText.location(finding)), \(finding.summary)")
        .accessibilityValue(hasScenario ? (open ? "Expanded" : "Collapsed") : "")
    }
}

/// "Review thread", one tap from the card; only drawn when this client has the reviewer's row.
struct ReviewerChip: View {
    let reviewerId: String

    var body: some View {
        NavigationLink(value: ThreadScreenRoute(sessionId: reviewerId)) {
            Text("Review thread")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Surface.fill, in: Capsule())
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("Open the review thread")
    }
}

/// A folded line under a card: chevron and label; the caller shows the body.
private struct FoldLine: View {
    @Binding var open: Bool
    let label: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button {
            withAnimation(reduceMotion ? Motion.crossFade : (open ? Motion.collapse : Motion.expand)) { open.toggle() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(open ? 90 : 0))
                Text(label)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
            .frame(minHeight: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityValue(open ? "Expanded" : "Collapsed")
    }
}

// MARK: - gate

/// The gate run's outcome: failed in destructive with its last lines folded
/// in mono, passed as a quiet line with a green check. No actions: the fix
/// is the thread's next turn.
struct GateCard: View {
    let gate: GateNotice
    @State private var open = false
    @Environment(\.displayScale) private var scale

    var body: some View {
        let lines = GateText.lineCount(gate.log)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: gate.ok ? "checkmark" : "exclamationmark.triangle")
                    .font(gate.ok ? .footnote : .footnote.weight(.medium))
                    .foregroundStyle(gate.ok ? Tint.success : Tint.destructive)
                    .frame(width: 16)
                (Text(GateText.lead(gate))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(gate.ok ? Color.secondary : Color.primary)
                 + Text(" · \(GateText.detail(gate))")
                    .font(.subheadline)
                    .foregroundStyle(gate.ok ? Color(.tertiaryLabel) : Color.secondary))
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
            if !gate.ok, lines > 0 {
                FoldLine(open: $open, label: GateText.foldLabel(lines: lines))
                if open {
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(gate.log.trimmingCharacters(in: .whitespacesAndNewlines))
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineSpacing(2)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) { Rectangle().fill(Surface.hairline).frame(width: 1 / scale) }
                    .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
                }
            }
        }
        .padding(.horizontal, 8)
        .accessibilityElement(children: .contain)
    }
}

// MARK: - the plain kinds

/// A batch landing or ending, in the host's words.
struct BatchLine: View {
    let message: String

    var body: some View {
        QuietLine(symbol: "square.stack.3d.up", text: message)
    }
}

/// An account that left this host; the message already ends with the time.
struct AccountGoneLine: View {
    let message: String

    var body: some View {
        QuietLine(symbol: "person.crop.circle.badge.xmark", text: message)
    }
}

/// The plan's own record of its build: the build's live row when this host
/// has it, else one quiet line with the title.
struct PlanHandoffRow: View {
    let line: SystemLine
    let client: EnvironmentClient

    var body: some View {
        AgentLinkRow(childId: line.detail, client: client, fallback: "Build started · \(line.text)", symbol: "hammer")
    }
}
