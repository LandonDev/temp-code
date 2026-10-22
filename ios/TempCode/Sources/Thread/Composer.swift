import PhotosUI
import SwiftUI
import TempCodeClient
import TempCodeContract

/// The bottom of every thread screen: the 28 pt working strip over the
/// composer bar, on the bar material. The strip never changes height and
/// the bar grows only while the person types (the chip row on focus, the
/// field with the text, the photos they attach), so nothing above shifts
/// when work starts or stops.
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
/// only once there is text, and the photo button beside the field. The
/// field grows with the text to five lines and scrolls past that; it never
/// changes height on focus. On focus a chip row appears above it naming
/// the model and reasoning the next turn runs with; each chip opens the
/// host's catalog, the same one the desktop's picker shows (the row arrives
/// with the house travel and fade, and leaves by fade alone). One button
/// swaps Send ↔ Stop the way the desktop's Action Swap does (the kit's
/// icon swap, the button never moves); a master mid-turn
/// with text sends, and the host steers the live turn with it. Photos go up
/// to the host as they are picked (ComposerAttachments.swift) and the turn
/// names them. While the host is degraded or the key cannot act, the field
/// carries the reason in place of its placeholder and nothing sends. A
/// light tap on send, never on typing.
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
    /// The photos of the next turn, each uploading as soon as it is picked.
    @State private var uploads: [PhotoUpload] = []
    @State private var picking = false
    @State private var picked: [PhotosPickerItem] = []
    @State private var photoCount = 0
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// A drop that comes back inside this never shows (the desktop's grace).
    static let blockGraceMs = 1_500
    /// The field: one line of body text with 7 pt above and below.
    static let fieldMinHeight: CGFloat = 36
    static let buttonSize: CGFloat = 28
    /// Photos per turn.
    static let maxPhotos = 4

    /// The host says a turn runs, or this device just sent one. A watching
    /// master is not running: its button is Send.
    private var running: Bool { ComposerRules.running(status: session?.status, sending: thread.sending) }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasText: Bool { !trimmed.isEmpty }

    /// What the button does: Stop while a turn runs and the box is empty, Send otherwise.
    private var stops: Bool { ComposerRules.stops(running: running, hasText: hasText) }

    /// Every photo is on the host; one still going up or failed holds the send (never Stop).
    private var photosSettled: Bool { uploads.allSatisfy { $0.committed != nil } }

    private var enabled: Bool { block == nil && !busy && (stops || (hasText && photosSettled)) }

    /// The chip row shows while the person composes, never over a block.
    private var chipsShown: Bool { block == nil && session != nil && (focused || hasText) }

    /// The photo button: the key operates and the host is reachable.
    private var canAttach: Bool { block == nil && client.environment.allows(.operate) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !uploads.isEmpty {
                AttachmentStrip(uploads: uploads, onRemove: remove, onRetry: retry)
                    .transition(Motion.appear(reduced: reduceMotion))
            }
            if chipsShown {
                chips
                    .transition(Motion.appear(reduced: reduceMotion))
            }
            fieldRow
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
        .animation(reduceMotion ? nil : Motion.collapse, value: uploads.isEmpty)
        .animation(Motion.crossFade, value: failure)
        .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
        .photosPicker(isPresented: $picking, selection: $picked, maxSelectionCount: max(1, Self.maxPhotos - uploads.count), matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            add(items)
            picked = []
        }
        .task(id: client.operateBlock) { await settleBlock() }
        .task(id: focused) { if focused { await choice.load(client) } }
        #if DEBUG
        .task {
            guard TestHooks.open == "composer", block == nil else { return }
            try? await Task.sleep(for: .seconds(2))
            focused = true
        }
        #endif
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

    /// The photo button beside the field, then the field with the action
    /// button inside at its trailing edge; both buttons stay on the field's
    /// last line while the text grows.
    private var fieldRow: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if canAttach {
                Button {
                    picking = true
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.primary)
                        .frame(width: Self.buttonSize, height: Self.buttonSize)
                        .background(Surface.fill, in: Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(.pressable)
                .disabled(uploads.count >= Self.maxPhotos)
                .padding(.bottom, (Self.fieldMinHeight - Self.buttonSize) / 2)
                .accessibilityLabel("Add photos")
                .transition(.opacity)
            }
            field
        }
        .animation(Motion.crossFade, value: canAttach)
    }

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
            ActionSwap(stops: stops, hasText: hasText, enabled: enabled, reduced: reduceMotion) {
                if stops { stop() } else { send() }
            }
            .padding(.trailing, 4)
            .padding(.bottom, (Self.fieldMinHeight - Self.buttonSize) / 2)
        }
        .background(Surface.chrome, in: RoundedRectangle.fieldCorner)
        .hairlineBorder(RoundedRectangle.fieldCorner)
    }

    private var placeholder: String {
        if let block {
            return block.text(now: Date().timeIntervalSince1970 * 1000)
        }
        return ComposerRules.placeholder(for: session)
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

    // MARK: photos

    private func add(_ items: [PhotosPickerItem]) {
        for item in items.prefix(Self.maxPhotos - uploads.count) {
            photoCount += 1
            let upload = PhotoUpload(item: item, number: photoCount)
            uploads.append(upload)
            upload.start(client, sessionId: sessionId)
        }
    }

    /// The chip goes and its upload stops; a photo already on the host is
    /// simply left out of the turn (the host keeps the file under the
    /// thread's attachment dir).
    private func remove(_ upload: PhotoUpload) {
        upload.cancel()
        uploads.removeAll { $0.id == upload.id }
    }

    private func retry(_ upload: PhotoUpload) {
        upload.start(client, sessionId: sessionId)
    }

    // MARK: send and stop

    private func send() {
        let body = trimmed
        guard !body.isEmpty, !busy, photosSettled else { return }
        busy = true
        // A keyboard action never animates: the field empties at once.
        Motion.withoutAnimation { text = "" }
        sentCount += 1
        // Only a pick rides on the turn: the catalog settling the chips onto a model the host has is not one.
        let settings = choice.picked ? session.flatMap { TurnModel.override(for: $0, provider: choice.key.provider, model: choice.key.model, reasoning: choice.reasoning) } : nil
        let photos = uploads
        let attachments = photos.compactMap(\.committed)
        uploads = []
        Task {
            defer { busy = false }
            do {
                try await client.send(sessionId, text: body, model: settings, attachments: attachments)
                // The pick went with the turn; the chips follow the thread's model again once its push lands.
                choice.release()
                // The person started this turn: it goes on the lock screen.
                if let session, session.parentId == nil { app.activities.sent(client, session, registry: app.registry) }
            } catch {
                // The text and the photos come back so nothing is lost (photos picked meanwhile stay).
                text = body
                uploads = photos + uploads
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
/// moment there is text (150 ms on color alone), and whose glyph trades
/// places between the arrow and the stop square with the kit's icon swap.
/// Both glyphs sit in the same frame, so the swap moves nothing around it.
/// Stop fills in the label color, the way the desktop's does.
private struct ActionSwap: View {
    let stops: Bool
    let hasText: Bool
    let enabled: Bool
    let reduced: Bool
    let action: () -> Void

    private var fill: Color {
        if stops { return Color(.label) }
        return hasText && enabled ? Color.accentColor : Surface.fill
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
                    .transition(Motion.iconSwap(reduced: reduced))
            }
            .frame(width: ComposerBar.buttonSize, height: ComposerBar.buttonSize)
            .animation(Motion.iconSwap, value: stops)
            .animation(Motion.crossFade, value: hasText && enabled)
            .contentShape(Circle())
        }
        .buttonStyle(.pressable)
        .disabled(!enabled)
        .accessibilityLabel(stops ? "Stop" : "Send")
    }
}
