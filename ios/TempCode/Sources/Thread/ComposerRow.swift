import SwiftUI
import TempCodeClient
import TempCodeContract

/// The row under the composer's box, the desktop's (docs/LAYOUT.md
/// "Composer"): 24 pt, 4 pt under the box and on its edges, always there,
/// in every pose. At the left the model and its effort, a menu of the
/// catalog's models by provider with a check on the current one and then
/// Effort with the model's ladder; a pick rides the next send as
/// `TurnModel`. At the right the context meter (a 14 pt ring and the
/// percent, amber from 85 %, a spinner while compacting, nothing until the
/// host reports a level and a window) and the permission mode
/// (`session.permission`, approve; a lesser key reads it). Quiet controls
/// in the detail type and secondary, each touch reaching 44 pt. A narrow row
/// gives way in the desktop's order and never wraps (`ComposerRow.fit`).
struct ComposerRowView: View {
    let client: EnvironmentClient
    let session: SessionMeta?
    let thread: ThreadState
    @Bindable var choice: CatalogChoice
    /// The row's own width, measured; unmeasured, everything fits.
    @State private var width: CGFloat?
    /// The mode this device asked for, shown until the host's push carries it (or refuses it).
    @State private var asked: PermissionPolicy?

    private var fit: ComposerRow.Fit { ComposerRow.fit(width: Double(width ?? .greatestFiniteMagnitude)) }

    /// The harness squeezes the window: the meter's ring turns to a spinner.
    private var compacting: Bool { thread.fold.board.compacting && ComposerRules.busy(status: session?.status, sending: thread.sending) }

    private var modelAccess: ComposerRow.Access {
        choice.catalog == nil ? .readOnly : ComposerRow.modelAccess(operate: client.environment.allows(.operate))
    }

    private var modeAccess: ComposerRow.Access {
        ComposerRow.modeAccess(hasThread: session != nil, approve: client.environment.allows(.approve))
    }

    var body: some View {
        // The widths give way at the default text size; a larger one keeps
        // giving way in the same order, and only the last lets the name truncate.
        let steps = ComposerRow.steps(from: fit)
        ViewThatFits(in: .horizontal) {
            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                content(step, truncates: false)
            }
            content(steps[steps.count - 1], truncates: true)
        }
        .padding(.horizontal, ComposerMetrics.side)
        .frame(minHeight: ComposerMetrics.row)
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onChange(of: session?.permission) { asked = nil }
    }

    private func content(_ fit: ComposerRow.Fit, truncates: Bool) -> some View {
        HStack(spacing: TranscriptMetrics.glyphGap) {
            model(fit, truncates: truncates)
            Spacer(minLength: 0)
            if let meter = ComposerRow.meter(session?.context, compacting: compacting) {
                MeterView(meter: meter, showsPercent: fit.percent)
                    .fixedSize()
                    .layoutPriority(1)
            }
            if modeAccess != .hidden, let session {
                mode(asked ?? session.permission, fit: fit)
                    .fixedSize()
                    .layoutPriority(1)
            }
        }
    }

    // MARK: the model

    private func model(_ fit: ComposerRow.Fit, truncates: Bool) -> some View {
        let label = HStack(spacing: TranscriptMetrics.wordGap) {
            ProviderGlyph(provider: choice.key.provider)
            if fit.modelName {
                Text(choice.modelLabel)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: !truncates, vertical: false)
            }
            if fit.effort, choice.levels.count > 1, let level = choice.reasoning {
                Text(level.label)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
        .transcriptType(TranscriptType.detail)
        .foregroundStyle(.secondary)
        .rowHit()
        let words = [choice.modelLabel, choice.levels.count > 1 ? choice.reasoning?.label : nil].compactMap { $0 }.joined(separator: ", ")
        return Group {
            if modelAccess == .editable {
                ModelMenu(choice: choice, effort: true) { label }
                    .quietMenu()
                    .accessibilityLabel("Model: \(words)")
            } else {
                label
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Model: \(words)")
            }
        }
    }

    // MARK: the permission mode

    private func mode(_ current: PermissionPolicy, fit: ComposerRow.Fit) -> some View {
        let label = HStack(spacing: TranscriptMetrics.wordGap) {
            Image(systemName: current.symbol)
                .transcriptFont(TranscriptType.detail)
            if fit.modeLabel {
                Text(current.label)
                    .transcriptType(TranscriptType.detail)
                    .lineLimit(1)
            }
        }
        .foregroundStyle(.secondary)
        .rowHit()
        return Group {
            if modeAccess == .editable {
                Menu {
                    ForEach(PermissionPolicy.choices, id: \.rawValue) { policy in
                        Button {
                            choose(policy)
                        } label: {
                            Label {
                                Text(policy.label)
                                Text(PermissionWords.hint(policy))
                            } icon: {
                                Image(systemName: policy == current ? "checkmark" : policy.symbol)
                            }
                        }
                    }
                } label: {
                    label
                }
                .menuOrder(.fixed)
                .quietMenu()
            } else {
                label
                    .accessibilityElement(children: .ignore)
            }
        }
        .accessibilityLabel("Permission mode: \(current.label)")
    }

    /// The pick shows at once; a refusal puts the host's mode back.
    private func choose(_ policy: PermissionPolicy) {
        guard let session, policy != (asked ?? session.permission) else { return }
        asked = policy
        Task {
            do {
                try await client.setPermission(session.id, policy)
            } catch {
                asked = nil
            }
        }
    }
}

/// The context meter: a 14 pt ring (a quarter-strength track and the filled
/// arc) and the percent in tabular digits, secondary below 85 % and amber
/// from it, never red; a spinner in the ring's place while the harness
/// compacts. A narrow row keeps the ring alone.
private struct MeterView: View {
    let meter: ComposerRow.Meter
    let showsPercent: Bool

    private var ink: Color { meter.tone == .warning ? Tint.warning : Color(.secondaryLabel) }

    var body: some View {
        HStack(spacing: TranscriptMetrics.wordGap) {
            ZStack {
                if meter.compacting {
                    ProgressView()
                        .controlSize(.mini)
                } else {
                    Circle()
                        .stroke(ink.opacity(ComposerMetrics.ringTrack), lineWidth: ComposerMetrics.ringStroke)
                    Circle()
                        .trim(from: 0, to: meter.ratio)
                        .stroke(ink, style: StrokeStyle(lineWidth: ComposerMetrics.ringStroke, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                }
            }
            .frame(width: ComposerMetrics.ring, height: ComposerMetrics.ring)
            if showsPercent {
                Text("\(meter.percent)%")
                    .transcriptType(TranscriptType.detail)
                    .numeric(meter.percent)
                    .foregroundStyle(ink)
            }
        }
        .frame(minHeight: ComposerMetrics.row)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Context \(meter.percent) percent used")
        .accessibilityValue(meter.label)
    }
}

private extension View {
    /// A menu drawn as its label alone: no system padding (the row's widths
    /// are the label's), no accent tint (the row is quiet).
    func quietMenu() -> some View {
        menuStyle(.button)
            .buttonStyle(.plain)
            .tint(Color(.secondaryLabel))
    }

    /// A row control's touch reaches 44 pt tall while it lays out at the row's 24.
    func rowHit() -> some View {
        frame(minHeight: ComposerMetrics.row)
            .padding(.vertical, ComposerMetrics.rowHitOutset)
            .contentShape(Rectangle())
            .padding(.vertical, -ComposerMetrics.rowHitOutset)
    }
}
