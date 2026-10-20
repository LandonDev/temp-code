import SwiftUI
import TempCodeClient
import TempCodeContract

/// The bottom of every thread screen: the 28 pt working strip over the
/// composer bar, on the bar material. The strip never changes height and
/// the bar grows only while the user types, so nothing above shifts when
/// work starts or stops.
struct BottomDock: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState

    var body: some View {
        VStack(spacing: 0) {
            WorkingStripView(client: client, sessionId: sessionId, session: session, thread: thread)
            ComposerBar(client: client, sessionId: sessionId, session: session, thread: thread)
        }
        .background(.bar)
    }
}

/// The composer: one line idle, growing with the text to six lines on
/// focus; one button that swaps Send ↔ Stop the way the desktop's Action
/// Swap does (150 ms cross-fade with 2 pt of blur, the button never moves).
/// While the host is degraded or the key cannot act, the field carries the
/// reason in place of its placeholder and nothing sends. Implementation and
/// orchestration threads idle smaller: steering, not chatting.
struct ComposerBar: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState
    @State private var text = ""
    @FocusState private var focused: Bool
    @State private var busy = false
    /// The host's refusal, shown under the field until the next edit.
    @State private var failure: String?
    /// The block after its grace: a short drop never flashes the field.
    @State private var block: ActionBlock?
    @State private var sentCount = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var scale

    /// A drop that comes back inside this never shows (the desktop's grace).
    static let blockGraceMs = 1_500

    private var compact: Bool {
        session?.parentId == nil && (session?.threadType == .implementation || session?.threadType == .orchestration)
    }

    private var running: Bool {
        session?.status == .running || session?.status == .starting || thread.sending
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// A steering thread's bar sits lower until the user types; the font never changes.
    private var idlesSmall: Bool { compact && !focused && text.isEmpty }

    /// What the button does: Stop while a turn runs and the box is empty, Send otherwise.
    private var stops: Bool { running && trimmed.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField(placeholder, text: $text, axis: .vertical)
                    .font(.body)
                    .lineLimit(1...6)
                    .focused($focused)
                    .disabled(block != nil)
                    .padding(.horizontal, 12)
                    .padding(.vertical, idlesSmall ? 6 : 9)
                    .frame(minHeight: idlesSmall ? 34 : 40)
                    .background(Surface.chrome, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.field, style: .continuous).strokeBorder(Surface.hairline, lineWidth: 1 / scale))
                    .onChange(of: text) { failure = nil }
                    .accessibilityLabel(block == nil ? "Message" : block!.text(now: Date().timeIntervalSince1970 * 1000))
                ActionSwap(stops: stops, enabled: block == nil && !busy && (stops || !trimmed.isEmpty), reduced: reduceMotion) {
                    if stops { stop() } else { send() }
                }
                .padding(.bottom, idlesSmall ? 3 : 6)
            }
            if let failure {
                Text(failure)
                    .font(.footnote)
                    .foregroundStyle(Tint.destructive)
                    .padding(.horizontal, 12)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 2)
        .padding(.bottom, 8)
        .animation(reduceMotion ? nil : Motion.collapse, value: focused)
        .animation(Motion.crossFade, value: failure)
        .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
        .task(id: client.operateBlock) { await settleBlock() }
    }

    private var placeholder: String {
        if let block {
            return block.text(now: Date().timeIntervalSince1970 * 1000)
        }
        if session?.parentId != nil { return "Message the agent" }
        return compact ? "Steer" : "Message"
    }

    /// The block as the field shows it: a read-only key or a halt at once,
    /// a dropped link only once it has stayed down past the grace.
    private func settleBlock() async {
        let now = client.operateBlock
        if now == nil || now?.isTransient == false {
            block = now
            return
        }
        if block != nil {
            block = now
            return
        }
        try? await Task.sleep(for: .milliseconds(Self.blockGraceMs))
        guard !Task.isCancelled else { return }
        block = client.operateBlock
    }

    private func send() {
        let body = trimmed
        guard !body.isEmpty, !busy else { return }
        busy = true
        text = ""
        sentCount += 1
        Task {
            defer { busy = false }
            do {
                try await client.send(sessionId, text: body)
            } catch {
                // The text comes back so nothing typed is lost.
                text = body
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }

    private func stop() {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await client.stop(sessionId)
            } catch {
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }
}

/// The composer's one button: a filled circle whose glyph cross-fades
/// between the arrow and the stop square. Both glyphs sit in the same
/// frame, so the swap moves nothing around it.
private struct ActionSwap: View {
    let stops: Bool
    let enabled: Bool
    let reduced: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(Color.primary)
                    .opacity(enabled ? 1 : 0.3)
                Image(systemName: stops ? "stop.fill" : "arrow.up")
                    .font(.system(size: stops ? 11 : 14, weight: .bold))
                    .foregroundStyle(Color(.systemBackground))
                    .id(stops)
                    .transition(Motion.swap(reduced: reduced))
            }
            .frame(width: 28, height: 28)
            .animation(Motion.crossFade, value: stops)
            .contentShape(Circle())
        }
        .buttonStyle(.pressable)
        .disabled(!enabled)
        .accessibilityLabel(stops ? "Stop" : "Send")
        .animation(Motion.crossFade, value: enabled)
    }
}
