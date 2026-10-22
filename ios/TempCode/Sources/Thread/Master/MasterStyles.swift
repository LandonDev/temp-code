import SwiftUI
import TempCodeClient
import TempCodeContract

/// The pieces the master board shares (docs/IOS-DESIGN.md "Master: the batch
/// is the hero"): its lengths, a step's mark, the model mark at a row's right,
/// the pin in a root thread's menu, the body transition and the pill a Menu
/// can wear. Every color, radius, step and duration is the design kit's.

enum MasterLayout {
    /// The running step's console grows with its lines up to this, then scrolls inside.
    static let consoleMaxHeight: CGFloat = 220
    static let consoleMinHeight: CGFloat = 60
    static let consolePadding: CGFloat = 10
    /// The board's bar under the segment control: + Thread and the batch's ⋯.
    static let barHeight: CGFloat = 44
    /// A row's body (tasks, summary) and its separator start under the title.
    static let bodyInset: CGFloat = Layout.rowTextEdge
    /// The foot's step rows have a mark and no type glyph: the fleet's inset.
    static let stepInset: CGFloat = FleetLayout.textInset
}

/// A step's state in the mark column: a check once passed, the platform's
/// spinner while running, the destructive dot once failed, a dashed ring
/// pending or skipped. Marks cross-fade in a frame that never changes size;
/// `weight` follows the step name beside it.
struct StepGlyph: View {
    let status: BatchStepStatus
    var weight: Font.Weight = .regular
    var dim = false
    @ScaledMetric(relativeTo: .subheadline) private var column = Layout.markWidth
    @ScaledMetric(relativeTo: .subheadline) private var dot = Layout.dotSize

    var body: some View {
        ZStack {
            switch status {
            case .passed:
                Image(systemName: "checkmark")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(dim ? AnyShapeStyle(.tertiary) : AnyShapeStyle(Tint.success))
                    .transition(.opacity)
            case .running:
                ProgressView()
                    .controlSize(.mini)
                    .transition(.opacity)
            case .failed:
                Circle()
                    .fill(Tint.destructive)
                    .frame(width: dot, height: dot)
                    .transition(.opacity)
            default:
                Image(systemName: "circle.dashed")
                    .font(.caption2.weight(weight))
                    .foregroundStyle(.tertiary)
                    .transition(.opacity)
            }
        }
        .frame(width: column, height: column)
        .animation(Motion.crossFade, value: status)
        .accessibilityLabel(label)
    }

    private var label: String {
        switch status {
        case .passed: "Passed"
        case .running: "Running"
        case .failed: "Failed"
        case .skipped: "Skipped"
        default: "Pending"
        }
    }
}

/// The provider's mark, the model, its effort and the 1M window in the stamp
/// step; the host's name first when the thread runs on another host.
struct ModelMark: View {
    let provider: ProviderId
    let model: String
    var reasoning: String = ""
    var context1m = false
    var hostName: String?

    var body: some View {
        let rest = [reasoning.isEmpty ? nil : reasoning, context1m ? "1M" : nil].compactMap { $0 }.joined(separator: " ")
        HStack(spacing: 4) {
            if let hostName {
                MetaGlyph("desktopcomputer", label: "Host")
                Text(hostName)
            }
            ProviderGlyph(provider: provider)
            Text(ModelName.short(model))
            if !rest.isEmpty {
                Text(rest).foregroundStyle(.secondary)
            }
        }
        .textStep(.stamp)
        .lineLimit(1)
        .fixedSize()
        .accessibilityElement(children: .combine)
    }
}

/// "Make master thread" / "Not the master" for a root thread in a project.
/// Admin only: a key without it sees the row disabled with the reason as its
/// hint. A refusal goes to `onFailure`; a menu with no alert of its own
/// passes nil and the pin simply stays as it was.
struct MasterPinButton: View {
    let client: EnvironmentClient
    let session: SessionMeta
    var onFailure: ((String) -> Void)? = nil

    var body: some View {
        if session.parentId == nil, session.projectId != nil {
            let pinned = session.isMaster == true
            Button {
                Task {
                    do {
                        try await client.setMaster(session.id, !pinned)
                    } catch {
                        onFailure?((error as? ActionError)?.message ?? String(describing: error))
                    }
                }
            } label: {
                Label(pinned ? "Not the master" : "Make master thread", systemImage: pinned ? "crown.slash" : "crown")
            }
            .disabled(client.adminBlock != nil)
            .accessibilityHint(client.adminBlock.map { $0.text(now: Date().timeIntervalSince1970 * 1000) } ?? "")
        }
    }
}

extension AnyTransition {
    /// The step console opening under its step: a spring in with a short drop, out on collapse.
    static func console(reduced: Bool) -> AnyTransition {
        reduced
            ? .opacity
            : .asymmetric(insertion: AnyTransition.opacity.combined(with: .move(edge: .top)).animation(Motion.expand), removal: AnyTransition.opacity.animation(Motion.collapse))
    }

    /// A row body opening under its row: fades in on the kit's expand timing, out on collapse.
    static func expandBody(reduced: Bool) -> AnyTransition {
        reduced
            ? .opacity
            : .asymmetric(insertion: .opacity.animation(Motion.expandContent), removal: .opacity.animation(Motion.collapse))
    }
}

/// The kit's PillButton look as a Menu's label (a Button cannot be one):
/// footnote medium on the fill capsule, 28 pt tall in a 44 pt hit area.
struct PillLabel: View {
    let title: String
    var systemImage: String?

    var body: some View {
        HStack(spacing: 5) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.footnote.weight(.medium))
                    .imageScale(.small)
            }
            Text(title)
                .font(.footnote.weight(.medium))
        }
        .padding(.leading, systemImage == nil ? 12 : 10)
        .padding(.trailing, 12)
        .padding(.vertical, 6)
        .foregroundStyle(.primary)
        .background(Surface.fill, in: Capsule())
        .padding(.vertical, 8)
        .contentShape(Rectangle())
    }
}
