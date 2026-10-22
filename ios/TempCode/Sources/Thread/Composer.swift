import PhotosUI
import SwiftUI
import TempCodeClient
import TempCodeContract

/// The bottom of every thread screen: the chat bar, floating over the
/// transcript the way Messages' does on iOS 26 (the content scrolls under
/// it behind the scroll edge effect; ThreadScreen hangs it with
/// `.tcBottomBar`). At rest it is the glass capsule and the attach circle
/// and nothing else; a status line rises above them only while there is
/// something to say (sending, working, paused, stopped, queued, a locked
/// relayed host), and the photos of the next turn and a picked model sit
/// above the capsule while there are any.
struct BottomDock: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var phase: WorkingPhase { WorkingPhase(status: session?.status, sending: thread.sending) }

    /// A relayed host that is locked or asleep says so on the status line while idle.
    private var relayLine: Bool {
        guard client.environment.isRelayed, let presence = client.presence else { return false }
        return RelayWords.stripLine(presence, lockedSince: client.stateSince, now: Date()) != nil
    }

    private var statusShown: Bool { phase != .idle || relayLine }

    var body: some View {
        VStack(spacing: 6) {
            if statusShown {
                WorkingStripView(client: client, sessionId: sessionId, session: session, thread: thread)
                    .transition(Motion.appear(reduced: reduceMotion))
            }
            ComposerBar(client: client, sessionId: sessionId, session: session, thread: thread)
        }
        .padding(.horizontal, ComposerBar.edge)
        .padding(.top, 6)
        .padding(.bottom, 6)
        .animation(reduceMotion ? Motion.crossFade : Motion.expand, value: statusShown)
    }
}

/// The composer, the way Messages draws it on iOS 26: one glass capsule
/// holding the field, and one glass circle beside it. The field grows with
/// the text to five lines and scrolls past that; the capsule keeps its
/// round ends as it grows (its corner is half its one-line height). The
/// send button lives inside the capsule at the trailing edge and shows only
/// once there is text; while a turn runs and the box is empty it is Stop,
/// and the glyphs trade places with the kit's icon swap. A master mid-turn
/// with text sends, and the host steers the live turn with it. The circle
/// is a menu: Photos, then the model and the reasoning the next turn runs
/// with (the host's catalog, the same one the desktop's picker shows); a
/// pick that differs from the thread's shows as one line above the capsule
/// until it goes out with the turn. Photos go up to the host as they are
/// picked (ComposerAttachments.swift). While the host is degraded or the
/// key cannot act, the field carries the reason in place of its placeholder,
/// the circle leaves and nothing sends. A light tap on send, never on typing.
struct ComposerBar: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let thread: ThreadState
    @State private var text = ""
    @FocusState private var focused: Bool
    @State private var busy = false
    /// The host's refusal, shown above the capsule until the next edit.
    @State private var failure: String?
    /// The block after its grace: a short drop never flashes the field.
    @State private var block: ActionBlock?
    @State private var sentCount = 0
    /// The thread's model until the person picks another; the pick rides
    /// on the next send and the choice follows the thread again.
    @State private var choice = CatalogChoice(provider: .claude, model: "", reasoning: nil)
    /// The photos of the next turn, each uploading as soon as it is picked.
    @State private var uploads: [PhotoUpload] = []
    @State private var picking = false
    @State private var picked: [PhotosPickerItem] = []
    @State private var photoCount = 0
    @Namespace private var glass
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The capsule at one line of body text, and the send circle inside it;
    /// both follow the text size, so the 5 pt between them holds.
    @ScaledMetric(relativeTo: .body) private var fieldHeight: CGFloat = 40
    @ScaledMetric(relativeTo: .body) private var buttonSize: CGFloat = 30

    /// A drop that comes back inside this never shows (the desktop's grace).
    static let blockGraceMs = 1_500
    /// From the screen edge to the capsule, and from the capsule's edge to its text.
    static let edge: CGFloat = 12
    static let textInset: CGFloat = 16
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

    /// The send circle: there is text to send, or a turn to stop.
    private var actionShown: Bool { block == nil && (stops || hasText) }

    /// A model or a level the person picked that differs from the thread's
    /// own: the line above the capsule names it until it goes out.
    private var pickShown: Bool {
        guard block == nil, choice.picked, let session else { return false }
        return choice.key.provider != session.provider || choice.key.model != session.model || choice.reasoning != session.reasoning
    }

    /// The photo button: the key operates and the host is reachable.
    private var canAttach: Bool { block == nil && client.environment.allows(.operate) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let failure {
                QuietLine(symbol: "exclamationmark.circle", text: failure, tint: Tint.destructive)
                    .transition(.opacity)
            }
            if pickShown {
                pickLine
                    .transition(Motion.appear(reduced: reduceMotion))
            }
            if !uploads.isEmpty {
                AttachmentStrip(uploads: uploads, onRemove: remove, onRetry: retry)
                    .transition(Motion.appear(reduced: reduceMotion))
            }
            TCGlassContainer {
                HStack(alignment: .bottom, spacing: GlassMetrics.mergeSpacing) {
                    if canAttach {
                        attachMenu
                            .tcGlassID("attach", in: glass)
                            .transition(.opacity)
                    }
                    capsule
                        .tcGlassID("field", in: glass)
                }
            }
        }
        .animation(reduceMotion ? nil : Motion.collapse, value: pickShown)
        .animation(reduceMotion ? nil : Motion.collapse, value: uploads.isEmpty)
        .animation(Motion.crossFade, value: failure)
        .animation(Motion.crossFade, value: canAttach)
        .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
        .photosPicker(isPresented: $picking, selection: $picked, maxSelectionCount: max(1, Self.maxPhotos - uploads.count), matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            add(items)
            picked = []
        }
        .task(id: client.operateBlock) { await settleBlock() }
        // The circle's menu offers the catalog: load it once the key may act.
        .task(id: canAttach) { if canAttach { await choice.load(client) } }
        #if DEBUG
        .task {
            guard TestHooks.open == "composer", block == nil else { return }
            try? await Task.sleep(for: .seconds(2))
            focused = true
        }
        #endif
        .task(id: session.map { "\($0.provider.rawValue)/\($0.model)/\($0.reasoning.rawValue)" }) {
            // The thread's own model lands (or changes under us): the choice follows it unless the person has a pick in hand.
            guard let session, !choice.picked else { return }
            choice.follow(session)
        }
    }

    /// The glass circle beside the capsule: Photos, then the model and the
    /// reasoning of the next turn, each a submenu with the current value
    /// as its subtitle. The circle is the capsule's height, so the two sit
    /// on one line and merge into one surface as they meet.
    private var attachMenu: some View {
        Menu {
            Button {
                picking = true
            } label: {
                Label("Photos", systemImage: "photo.on.rectangle")
            }
            .disabled(uploads.count >= Self.maxPhotos)
            if session != nil, choice.catalog != nil {
                Section {
                    ModelMenu(choice: choice) {
                        Label {
                            Text("Model")
                            Text(choice.modelLabel)
                        } icon: {
                            Image(systemName: "cpu")
                        }
                    }
                    if choice.levels.count > 1, let level = choice.reasoning {
                        ReasoningMenu(choice: choice) {
                            Label {
                                Text("Reasoning")
                                Text(level.label)
                            } icon: {
                                Image(systemName: "gauge.with.dots.needle.50percent")
                            }
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "plus")
                .font(.body.weight(.medium))
                .foregroundStyle(Color.primary)
                .frame(width: fieldHeight, height: fieldHeight)
                .tcGlass(in: Circle(), interactive: true)
                .contentShape(Circle())
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Add")
        .accessibilityHint("Photos, the model and the reasoning")
    }

    /// The pick that rides on the next turn: the model in the label color,
    /// its level after it in secondary, and a clear control that hands the
    /// choice back to the thread.
    private var pickLine: some View {
        HStack(spacing: 6) {
            Image(systemName: "cpu")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(choice.modelLabel)
                .font(.footnote.weight(.medium))
                .lineLimit(1)
            if choice.levels.count > 1, let level = choice.reasoning {
                Text(level.label)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button {
                if let session { choice.follow(session) }
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.body)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .accessibilityLabel("Use the thread's model")
        }
        .padding(.leading, Self.textInset)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Next turn runs on \(choice.modelLabel)")
    }

    /// The glass capsule: the field, and the send circle inside it on the
    /// last line while the text grows.
    private var capsule: some View {
        HStack(alignment: .bottom, spacing: 0) {
            TextField(placeholder, text: $text, axis: .vertical)
                .font(.body)
                .lineLimit(1...5)
                .focused($focused)
                .disabled(block != nil)
                .padding(.leading, Self.textInset)
                .padding(.trailing, actionShown ? 0 : Self.textInset)
                .padding(.vertical, 8)
                .frame(minHeight: fieldHeight)
                .onChange(of: text) { failure = nil }
                .accessibilityLabel(block == nil ? "Message" : block!.text(now: Date().timeIntervalSince1970 * 1000))
            if actionShown {
                ActionSwap(stops: stops, enabled: enabled, size: buttonSize, frame: fieldHeight, reduced: reduceMotion) {
                    if stops { stop() } else { send() }
                }
                .transition(Motion.iconSwap(reduced: reduceMotion))
            }
        }
        .animation(Motion.iconSwap, value: actionShown)
        .tcGlass(in: RoundedRectangle.corner(Radius.capsuleEnds(fieldHeight)))
        .contentShape(RoundedRectangle.corner(Radius.capsuleEnds(fieldHeight)))
        .onTapGesture { if block == nil { focused = true } }
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

/// The capsule's one button: the accent circle with the arrow while there
/// is text, the label-colored circle with the stop square while a turn runs
/// and the box is empty. The glyphs trade places with the kit's icon swap
/// inside the same frame, so the swap moves nothing around it. A send held
/// back (a photo still going up) dims. The button's square is the capsule's
/// whole end, so the hit area is the end and the circle is concentric in it.
private struct ActionSwap: View {
    let stops: Bool
    let enabled: Bool
    let size: CGFloat
    /// The square the button takes: the capsule's one-line height, so the circle sits concentric in its end.
    let frame: CGFloat
    let reduced: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(stops ? Color(.label) : Color.accentColor)
                Image(systemName: stops ? "stop.fill" : "arrow.up")
                    .font(.system(size: size * (stops ? 0.38 : 0.5), weight: .semibold))
                    .foregroundStyle(stops ? Color(.systemBackground) : Color.white)
                    .id(stops)
                    .transition(Motion.iconSwap(reduced: reduced))
            }
            .frame(width: size, height: size)
            .opacity(enabled ? 1 : 0.4)
            .animation(Motion.iconSwap, value: stops)
            .animation(Motion.crossFade, value: enabled)
            .frame(width: frame, height: frame)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .disabled(!enabled)
        .accessibilityLabel(stops ? "Stop" : "Send")
    }
}
