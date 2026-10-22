import SwiftUI
import TempCodeClient
import TempCodeContract

/// The board's last section, under "When the threads are done": the
/// master's summary line, the rules as one sentence, what blocks the end,
/// then the steps as the master wrote them, each with its mark, name, a
/// shell step's command, its time, and on the step the console shows, Stop
/// (a running shell or publish step) or Hide (a failed one). The console
/// opens under its step. Each piece is a list row; separators start at the
/// step's text.
struct BatchFoot: View {
    let state: BatchState
    let steps: [BatchSteps.LiveStep]
    @Binding var folded: Set<String>
    let titleOf: (String) -> String?
    let hostName: (String) -> String?
    let block: ActionBlock?
    let onStop: (String) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let console = BatchSteps.consoleStep(steps, folded: folded)
        let summary = state.rules.summary?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let blocked = MasterBoard.blockedLine(state, titleOf: titleOf, hostName: hostName)
        Group {
            if !summary.isEmpty {
                Text(summary)
                    .font(.footnote)
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, Layout.textEdge)
                    .padding(.vertical, 8)
                    .footRow(inset: Layout.textEdge)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(MasterBoard.rulesSentence(state.rules))
                    .textStep(.meta)
                if let blocked {
                    Text(blocked)
                        .textStep(.meta, tint: Tint.destructive)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Layout.textEdge)
            .padding(.vertical, 8)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("batch-rules")
            .footRow(inset: Layout.textEdge)
            // A step running again after the person hid a failed one opens the console again.
            .onChange(of: steps.map(\.status)) {
                if steps.contains(where: { $0.status == .running }), !folded.isEmpty { folded = [] }
            }
            ForEach(steps) { step in
                StepRow(step: step, showsControl: step.id == console?.id, block: block, onStop: { onStop(step.id) }, onHide: { folded.insert(step.id) })
                    .footRow(inset: MasterLayout.stepInset)
                if step.id == console?.id {
                    StepConsole(step: step)
                        .transition(AnyTransition.console(reduced: reduceMotion))
                        .footRow(inset: MasterLayout.stepInset)
                        .listRowSeparator(.hidden, edges: .top)
                }
            }
        }
        .animation(reduceMotion ? nil : Motion.expand, value: console?.id)
    }
}

private extension View {
    /// A list row of the foot: no row insets, the separator at `inset`.
    func footRow(inset: CGFloat) -> some View {
        listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            .alignmentGuide(.listRowSeparatorLeading) { _ in inset }
    }
}

/// One step of the batch: the mark, the name (destructive once failed,
/// primary while running, quiet pending or skipped), a shell step's command
/// in mono, the status word of a skipped step, its time, and the control
/// the console's step carries.
private struct StepRow: View {
    let step: BatchSteps.LiveStep
    let showsControl: Bool
    let block: ActionBlock?
    let onStop: () -> Void
    let onHide: () -> Void

    var body: some View {
        let running = step.status == .running
        let failed = step.status == .failed
        HStack(alignment: .center, spacing: Layout.rowGap) {
            StepGlyph(status: step.status, weight: running ? .semibold : .regular, dim: !running)
            Text(step.name)
                .textStep(.meta, weight: running ? .medium : .regular)
                .foregroundStyle(nameStyle)
                .lineLimit(1)
            if step.kind == .shell, let run = step.run, !run.isEmpty {
                Text(run)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if !failed, let word = BatchSteps.statusWord(step.status) {
                Text(word)
                    .textStep(.meta)
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 8)
            if running, let since = step.startedAt {
                ElapsedText(since: since)
            } else if let time = BatchSteps.time(step, now: Int(Date.now.timeIntervalSince1970 * 1000)) {
                Text(time).textStep(.stamp)
            }
            if showsControl {
                ZStack {
                    if failed {
                        PillButton("Hide", systemImage: "chevron.up", action: onHide)
                            .iconSwapTransition()
                    } else if BatchSteps.stoppable(step) {
                        PillButton("Stop", systemImage: "stop.fill", action: onStop)
                            .disabled(block != nil)
                            .accessibilityHint(block.map { $0.text(now: Date().timeIntervalSince1970 * 1000) } ?? "Stops this step")
                            .iconSwapTransition()
                    }
                }
                .animation(Motion.iconSwap, value: failed)
            }
        }
        .padding(.horizontal, Layout.textEdge)
        .padding(.vertical, 6)
        .frame(minHeight: 36)
        .accessibilityIdentifier("step-\(step.id)")
    }

    private var nameStyle: AnyShapeStyle {
        switch step.status {
        case .failed: AnyShapeStyle(Tint.destructive)
        case .running: AnyShapeStyle(.primary)
        case .pending, .skipped: AnyShapeStyle(.tertiary)
        default: AnyShapeStyle(.secondary)
        }
    }
}
