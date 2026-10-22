import SwiftUI
import TempCodeClient
import TempCodeContract

/// A host's landing lines in a pass: gate runs and review verdicts, in the
/// order they landed, after Changes and before the Report. Quiet rows: the
/// text says what each is, so there is no header. Thread 19's notice cards
/// replace the two rows here; the swap point is the `switch` below.
struct OutcomeRows: View {
    let items: [ThreadEntry]
    let client: EnvironmentClient

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(items) { entry in
                if case .system(let line) = entry.item, let notice = line.notice {
                    if let gate = notice.gate {
                        GateRow(gate: gate)
                    } else if let review = notice.review {
                        ReviewRow(review: review, ts: entry.ts, client: client)
                    }
                }
            }
        }
        .padding(.horizontal, Layout.textEdge)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }
}

/// One gate run: "Typecheck passed on <branch>" with a check in the success
/// tint, or the failure in the destructive tint with its error count or
/// failed step. A failed run opens its last 20 lines on a tap, the shape of
/// a tool chip's body; a passed one never expands.
struct GateRow: View {
    let gate: NoticeEvent.Gate
    @State private var open: Bool

    init(gate: NoticeEvent.Gate) {
        self.gate = gate
        // The proof's `TC_TEST_OPEN=gate` shoots the failed row with its tail out.
        _open = State(initialValue: !gate.ok && TestHooks.open == "gate")
    }

    var body: some View {
        if gate.ok {
            line
        } else {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(open ? Motion.collapse : Motion.expand) { open.toggle() }
                } label: {
                    line
                }
                .buttonStyle(.pressable)
                .accessibilityHint(open ? "Hides the gate's last lines" : "Shows the gate's last lines")
                if open {
                    Text(GateLine.tail(gate.log, lines: 20))
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(Surface.chrome, in: RoundedRectangle.rowCorner)
                        .padding(.top, 4)
                        .transition(.asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse)))
                }
            }
        }
    }

    private var line: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: gate.ok ? "checkmark.circle" : "xmark.circle")
                .font(.footnote.weight(.regular))
                .foregroundStyle(gate.ok ? Tint.success : Tint.destructive)
                .frame(width: 16)
            Text(GateLine.text(gate))
                .textStep(.meta, tint: gate.ok ? nil : Tint.destructive)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 8)
            AgoText(gate.at)
        }
        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// One review verdict: the glyph by outcome, the desktop ReviewCard's lead
/// and summary, when it landed. A held review sits on the needs-you field
/// with its findings as plain rows under it and a pill to the reviewer
/// thread; the phone never offers Merge anyway (`review.override` needs the
/// approve capability and is off the phone's wire), so the summary says
/// "merge held" and the desktop holds the override.
struct ReviewRow: View {
    let review: NoticeEvent.Review
    /// When the notice landed (the row's time; the payload carries none).
    let ts: Int
    let client: EnvironmentClient

    private var held: Bool { ReviewLine.isHeld(review) }
    private var reviewer: SessionMeta? { review.reviewerId.flatMap { client.session($0) } }
    /// The pill earns its place when there is something to read in the reviewer's thread.
    private var hasFindings: Bool { !review.blocking.isEmpty || !review.minor.isEmpty }

    var body: some View {
        if held {
            content
                .padding(12)
                .background(Surface.needsYou, in: RoundedRectangle.fieldCorner)
        } else {
            content
                .frame(minHeight: 32)
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: symbol)
                    .font(.footnote.weight(held ? .medium : .regular))
                    .foregroundStyle(tint)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ReviewLine.lead(review))
                        .textStep(.title, weight: held ? .medium : .regular)
                    let summary = ReviewLine.summary(review)
                    if !summary.isEmpty {
                        Text(summary)
                            .textStep(.meta)
                    }
                }
                Spacer(minLength: 8)
                AgoText(ts)
            }
            .accessibilityElement(children: .combine)
            if held {
                findings
            }
            if held || hasFindings, let reviewer {
                ReviewerPill(reviewer: reviewer)
                    .padding(.leading, 24)
            }
        }
    }

    /// Every blocking finding, then the minor ones dimmer while the list stays
    /// short; a long one folds the minor findings into one line.
    @ViewBuilder private var findings: some View {
        let blocking = review.blocking.map { ReviewFinding(file: $0.file, line: $0.line, summary: $0.summary, scenario: $0.failure_scenario) }
        let minor = review.minor.map { ReviewFinding(file: $0.file, line: $0.line, summary: $0.summary, scenario: $0.failure_scenario) }
        // Findings are plain rows inside the field: Radius.inside(Radius.field, padding: 12) is 0.
        // Two findings can share a file and line, so the position is the row's identity.
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocking.enumerated()), id: \.offset) { FindingRow(finding: $0.element, strong: true) }
            if blocking.count + minor.count < 6 {
                ForEach(Array(minor.enumerated()), id: \.offset) { FindingRow(finding: $0.element, strong: false) }
            } else if !minor.isEmpty {
                Text("and \(minor.count) minor")
                    .textStep(.meta)
            }
        }
        .padding(.leading, 24)
    }

    private var symbol: String {
        switch review.outcome {
        case .pass, .skipped, .mergedAnyway: "checkmark.circle"
        case .held: "exclamationmark.circle"
        case .timeout, .failed, .unknown: "circle.dotted"
        }
    }

    private var tint: Color {
        switch review.outcome {
        case .pass, .skipped: Tint.success
        case .held: review.merged ? Color(.secondaryLabel) : Tint.warning
        case .mergedAnyway, .timeout, .failed, .unknown: Color(.secondaryLabel)
        }
    }
}

/// A finding's three lines: where (mono, trimmed in the middle), what, and
/// how it fails. Blocking findings read in the step's full colours; minor
/// ones step every line down.
struct FindingRow: View {
    let finding: ReviewFinding
    let strong: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(finding.location)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(strong ? .secondary : .tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(finding.summary)
                .textStep(.meta, tint: strong ? nil : Color(.tertiaryLabel))
                .lineLimit(2)
            Text(finding.scenario)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// One finding of either kind, as the rows read it.
struct ReviewFinding: Hashable {
    let file: String
    let line: Int?
    let summary: String
    let scenario: String

    var location: String { line.map { "\(file):\($0)" } ?? file }
}

/// The kit's pill as a push: the reviewer thread, so the person can read the
/// findings in their context. `PillButton` runs an action; a route needs a
/// `NavigationLink`, so the label repeats the pill's shape (28 pt capsule on
/// the fill step, a 44 pt hit area).
private struct ReviewerPill: View {
    let reviewer: SessionMeta

    var body: some View {
        NavigationLink(value: ThreadScreenRoute(sessionId: reviewer.id)) {
            HStack(spacing: 5) {
                Image(systemName: "checklist")
                    .font(.footnote.weight(.medium))
                    .imageScale(.small)
                Text("Reviewer")
                    .font(.footnote.weight(.medium))
            }
            .padding(.leading, 10)
            .padding(.trailing, 12)
            .padding(.vertical, 6)
            .foregroundStyle(.primary)
            .background(Surface.fill, in: Capsule())
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .accessibilityLabel("Reviewer")
        .accessibilityHint("Opens the reviewer thread")
    }
}
