import SwiftUI
import TempCodeClient
import TempCodeContract

/// The bottom of every thread screen: the 28 pt working strip over the
/// composer bar, on the bar material. The strip never changes height and
/// the bar grows only while the person types (the chip row on focus, the
/// field with the text), so nothing above shifts when work starts or stops.
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

/// The composer, the way Messages does it: one 12 pt field with a hairline,
/// the send button inside it at the trailing edge, filling in the accent
/// only once there is text. The field grows with the text to five lines
/// and scrolls past that. On focus a chip row appears above it naming the
/// model and reasoning the next turn runs with; each chip opens the host's
/// catalog, the same one the desktop's picker shows (the row arrives with
/// the house travel and fade, and leaves by fade alone). One button swaps
/// Send ↔ Stop the way the desktop's Action Swap does (150 ms cross-fade
/// with 2 pt of blur, the button never moves). While the host is degraded
/// or the key cannot act, the field carries the reason in place of its
/// placeholder and nothing sends. A light tap on send, never on typing.
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
    /// The chips: the thread's model until the person picks another; the
    /// pick rides on the next send and the chips follow the thread again.
    @State private var choice = CatalogChoice(provider: .claude, model: "", reasoning: nil)
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var scale

    /// A drop that comes back inside this never shows (the desktop's grace).
    static let blockGraceMs = 1_500
    /// The field: one line of body text with 8 pt above and below.
    static let fieldMinHeight: CGFloat = 36
    static let buttonSize: CGFloat = 28

    private var running: Bool {
        session?.status == .running || session?.status == .starting || thread.sending
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasText: Bool { !trimmed.isEmpty }

    /// What the button does: Stop while a turn runs and the box is empty, Send otherwise.
    private var stops: Bool { running && !hasText }

    /// The chip row shows while the person composes, never over a block.
    private var chipsShown: Bool { block == nil && session != nil && (focused || hasText) }

    private var fieldShape: RoundedRectangle { RoundedRectangle(cornerRadius: Radius.field, style: .continuous) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if chipsShown {
                chips
                    .transition(Motion.appear(reduced: reduceMotion))
            }
            field
            if let failure {
                QuietLine(symbol: "arrow.uturn.backward", text: failure)
                    .padding(.horizontal, 4)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 2)
        .padding(.bottom, 8)
        .animation(reduceMotion ? nil : Motion.collapse, value: chipsShown)
        .animation(Motion.crossFade, value: failure)
        .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
        .task(id: client.operateBlock) { await settleBlock() }
        .task(id: focused) { if focused { await choice.load(client) } }
        .task(id: session.map { "\($0.provider.rawValue)/\($0.model)/\($0.reasoning.rawValue)" }) {
            // The thread's own model lands (or changes under us): the chips follow it unless the person has a pick in hand.
            guard let session, !choice.picked else { return }
            choice.follow(session)
        }
    }

    /// Model and reasoning, each a chip opening its menu; a catalog still
    /// loading or missing leaves the model chip naming the thread's model
    /// with no menu behind it.
    private var chips: some View {
        HStack(spacing: 6) {
            if choice.catalog == nil {
                MenuChip(text: choice.modelLabel, symbol: "cpu", enabled: false)
                    .accessibilityLabel("Model \(choice.modelLabel)")
            } else {
                ModelMenu(choice: choice) {
                    MenuChip(text: choice.modelLabel, symbol: "cpu")
                }
                .accessibilityLabel("Model \(choice.modelLabel)")
                if choice.levels.count > 1, let level = choice.reasoning {
                    ReasoningMenu(choice: choice) {
                        MenuChip(text: level.label, symbol: "dial.medium")
                    }
                    .accessibilityLabel("Reasoning \(level.label)")
                    .transition(.opacity)
                }
            }
            Spacer(minLength: 0)
        }
        .animation(Motion.crossFade, value: choice.levels.count > 1)
    }

    /// The field with the button inside at the trailing edge; the button
    /// stays on the last line while the text grows.
    private var field: some View {
        HStack(alignment: .bottom, spacing: 6) {
            TextField(placeholder, text: $text, axis: .vertical)
                .font(.body)
                .lineLimit(1...5)
                .focused($focused)
                .disabled(block != nil)
                .padding(.leading, 12)
                .padding(.vertical, 7)
                .frame(minHeight: Self.fieldMinHeight)
                .onChange(of: text) { failure = nil }
                .accessibilityLabel(block == nil ? "Message" : block!.text(now: Date().timeIntervalSince1970 * 1000))
            ActionSwap(stops: stops, hasText: hasText, enabled: block == nil && !busy && (stops || hasText), reduced: reduceMotion) {
                if stops { stop() } else { send() }
            }
            .padding(.trailing, 4)
            .padding(.bottom, (Self.fieldMinHeight - Self.buttonSize) / 2)
        }
        .background(Surface.chrome, in: fieldShape)
        .overlay(fieldShape.strokeBorder(Surface.hairline, lineWidth: 1 / scale))
    }

    private var placeholder: String {
        if let block {
            return block.text(now: Date().timeIntervalSince1970 * 1000)
        }
        if session?.parentId != nil { return "Message the agent" }
        if let session, session.threadType == .implementation || session.threadType == .orchestration { return "Steer" }
        return "Message"
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
        let settings = session.flatMap { TurnModel.override(for: $0, provider: choice.key.provider, model: choice.key.model, reasoning: choice.reasoning) }
        Task {
            defer { busy = false }
            do {
                try await client.send(sessionId, text: body, model: settings)
                // The pick went with the turn; the chips follow the thread's model from here.
                if let session { choice.follow(session) }
                // The person started this turn: it goes on the lock screen.
                if let session, session.parentId == nil { app.activities.sent(client, session, registry: app.registry) }
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

/// The composer's one button: a circle whose fill turns to the accent the
/// moment there is text (150 ms on color alone), and whose glyph
/// cross-fades between the arrow and the stop square. Both glyphs sit in
/// the same frame, so the swap moves nothing around it. Stop fills in the
/// label color, the way the desktop's does.
private struct ActionSwap: View {
    let stops: Bool
    let hasText: Bool
    let enabled: Bool
    let reduced: Bool
    let action: () -> Void

    private var fill: Color {
        if stops { return Color.primary }
        return hasText && enabled ? Color.accentColor : Color(.tertiarySystemFill)
    }

    private var glyph: Color {
        if stops { return Color(.systemBackground) }
        return hasText && enabled ? Color.white : Color(.tertiaryLabel)
    }

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(fill)
                Image(systemName: stops ? "stop.fill" : "arrow.up")
                    .font(.system(size: stops ? 11 : 15, weight: .semibold))
                    .foregroundStyle(glyph)
                    .id(stops)
                    .transition(Motion.swap(reduced: reduced))
            }
            .frame(width: ComposerBar.buttonSize, height: ComposerBar.buttonSize)
            .animation(Motion.crossFade, value: stops)
            .animation(Motion.crossFade, value: hasText && enabled)
            .contentShape(Circle())
        }
        .buttonStyle(.pressable)
        .disabled(!enabled)
        .accessibilityLabel(stops ? "Stop" : "Send")
    }
}
