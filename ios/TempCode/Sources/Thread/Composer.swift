import PhotosUI
import SwiftUI
import TempCodeClient
import TempCodeContract

/// The bottom of every thread screen: the slot above the composer and the
/// composer's box, floating over the transcript (the content scrolls under
/// them behind the scroll edge effect; ThreadScreen hangs them with
/// `.tcBottomBar`). Both share the transcript's column and edges. The slot
/// (`ComposerSlot`) keeps its 28 pt at regular width whatever it holds; at
/// compact width it rises in on the layout spring when it has something and
/// leaves on a fade, the box gliding down after it. The photos of the next
/// turn and a picked model sit above the box while there are any. The soft
/// edge under the bar (`BottomEdgeFade`) is the dock's own background, so in
/// two-pane it spans the chat column the dock sits under and nothing else.
/// The screen owns the composer's focus (`focused`) for the segment bar
/// rule, and `draft` is the proof's `draft:` text, typed into the field once.
struct BottomDock: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let dock: DockState
    let focused: FocusState<Bool>.Binding
    /// The screen's width class: regular keeps the slot's room reserved.
    var regularWidth = false
    var draft: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var slot: ComposerSlot { ComposerSlot(status: session?.status, sending: dock.sending) }

    /// A relayed host that is locked or asleep says so in the slot while it is empty.
    private var relayLine: Bool {
        guard client.environment.isRelayed, let presence = client.presence else { return false }
        return RelayWords.stripLine(presence, lockedSince: client.stateSince, now: Date()) != nil
    }

    private var occupies: Bool { ComposerSlot.occupies(slot, regularWidth: regularWidth, relayLine: relayLine) }

    /// Rising in on the layout spring (a fade under reduced motion); leaving
    /// inert on a fade over `fast`, at once under reduced motion.
    private var slotTransition: AnyTransition {
        reduceMotion
            ? .asymmetric(insertion: .opacity.animation(Motion.fast), removal: .identity)
            : .asymmetric(
                insertion: .opacity.combined(with: .offset(y: Motion.travel)).animation(Motion.layout),
                removal: .opacity.animation(Motion.fast)
            )
    }

    var body: some View {
        let backing = ComposerSlot.backing(occupies: occupies)
        VStack(spacing: ComposerMetrics.slotGap) {
            if occupies {
                WorkingStripView(client: client, sessionId: sessionId, session: session, dock: dock, slot: slot)
                    .transition(slotTransition)
                    #if DEBUG
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { LayoutProbe.note("slot.frame", LayoutProbe.rect($0)) }
                    #endif
            }
            ComposerBar(client: client, sessionId: sessionId, session: session, dock: dock, focused: focused, draft: draft)
                #if DEBUG
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { LayoutProbe.note("composer.frame", LayoutProbe.rect($0)) }
                #endif
        }
        // The dock is its parts' height in every pose and at every size change, never
        // what the bar offers: the band behind it (`BottomEdgeFade`) and the scroll edge
        // effect over the transcript are this height and the fade above it.
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, ComposerBar.edge)
        .padding(.top, 6)
        .padding(.bottom, 6)
        // A slot that takes room has its own band, solid from its top (`ComposerSlot.backing`).
        .background(alignment: .top) {
            BottomEdgeFade(solid: backing == .solid)
                #if DEBUG
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { LayoutProbe.note("dock.fade.frame", LayoutProbe.rect($0)) }
                #endif
        }
        #if DEBUG
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { LayoutProbe.note("dock.frame", LayoutProbe.rect($0)) }
        #endif
        #if DEBUG
        .onChange(of: backing, initial: true) { LayoutProbe.note("dock.backing", backing.rawValue) }
        .onChange(of: occupies, initial: true) { if !occupies { LayoutProbe.note("slot.frame", "none") } }
        #endif
        .animation(reduceMotion ? (occupies ? Motion.fast : nil) : (occupies ? Motion.layout : Motion.fast), value: occupies)
    }
}

/// The composer, the desktop's box drawn as one Liquid Glass shape at the
/// field radius (`ComposerMetrics`): `+` at the left (Photos), the field in
/// the prose type, and the one button at the right, on the bottom line as
/// the text grows; under it the row (`ComposerRowView`: the model and its
/// effort, the context meter, the permission mode). The field grows upward
/// 22 pt a line to six lines and scrolls past that; a keystroke snaps the
/// height and a paste of more than one line eases it over `base`
/// (`ComposerHeight`). The button is the desktop's `SendButton`
/// (`ComposerRules`): Send; the steer glyph mid-turn with text; Pause
/// mid-turn with the box empty; a paused thread's text queues. A long press
/// mid-turn with text offers "Queue for the next turn" (`queue.add`) and
/// shows the queue glyph until release; the glyphs trade on the icon swap.
/// Stop lives in the slot above. A model or effort picked in the row rides
/// the next send (`TurnModel`). Photos go up to the host as they are picked
/// (ComposerAttachments.swift). While the host is degraded or the key
/// cannot act, the field carries the reason in place of its placeholder,
/// `+` and the button leave and nothing sends. A light tap on send and on a
/// queue, a selection tick when the hold turns into a queue, never on typing.
struct ComposerBar: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    let dock: DockState
    /// The screen's focus state: it reads it for the segment bar rule in compact height.
    let focused: FocusState<Bool>.Binding
    /// DEBUG proof: text to type into the field and focus, once, without sending.
    var draft: String?
    @State private var text = ""
    @State private var busy = false
    /// The host's refusal, shown above the box until the next edit.
    @State private var failure: String?
    /// A message that went to the host's queue, said once above the box until the next edit or the turn's end.
    @State private var queuedNote = false
    /// The long press holds: the button shows the queue glyph until release.
    @State private var holding = false
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
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// A drop that comes back inside this never shows (the desktop's grace).
    static let blockGraceMs = 1_500
    /// From the screen edge to the box: the transcript's text edge, so both share one column.
    static let edge = ReadingMeasure.edge
    /// Photos per turn.
    static let maxPhotos = 4

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasText: Bool { !trimmed.isEmpty }
    /// A photo is content as text is: alone in the box mid-turn it steers.
    private var hasPhotos: Bool { !uploads.isEmpty }

    /// A turn is open (a watching master's is not): the button pauses or steers.
    private var turnOpen: Bool { ComposerRules.busy(status: session?.status, sending: dock.sending) }

    /// What the button does now.
    private var intent: ComposerIntent {
        ComposerRules.intent(status: session?.status, sending: dock.sending, hasText: hasText, hasPhotos: hasPhotos, holding: holding)
    }

    private var offersQueue: Bool { ComposerRules.offersQueue(status: session?.status, sending: dock.sending, hasText: hasText, hasPhotos: hasPhotos) }

    /// Every photo is on the host; one still going up or failed holds the send (never Pause).
    private var photosSettled: Bool { uploads.allSatisfy { $0.committed != nil } }

    private var enabled: Bool { block == nil && ComposerRules.enabled(intent, hasText: hasText, hasPhotos: hasPhotos, photosSettled: photosSettled, inFlight: busy) }

    /// `+`: the key operates and the host is reachable.
    private var canAttach: Bool { block == nil && client.environment.allows(.operate) }

    /// The text as the field writes it: a paste of more than one line eases the height, a keystroke snaps it.
    private var field: Binding<String> {
        Binding {
            text
        } set: { new in
            if ComposerHeight.eases(from: text, to: new), !reduceMotion {
                withAnimation(Motion.base) { text = new }
            } else {
                Motion.withoutAnimation { text = new }
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let failure {
                QuietLine(symbol: "exclamationmark.circle", text: failure, tint: Tint.destructive)
                    .transition(.opacity)
            } else if holding {
                QuietLine(symbol: ComposerButton.symbol(.queue), text: ComposerIntent.queue.label)
                    .transition(.opacity)
            } else if queuedNote {
                QuietLine(symbol: ComposerButton.symbol(.queue), text: "Queued for the next turn")
                    .transition(.opacity)
            }
            if !uploads.isEmpty {
                AttachmentStrip(uploads: uploads, onRemove: remove, onRetry: retry)
                    .transition(Motion.appear(reduced: reduceMotion))
            }
            VStack(spacing: ComposerMetrics.rowGap) {
                TCGlassContainer {
                    box
                }
                ComposerRowView(client: client, session: session, dock: dock, choice: choice)
            }
        }
        .animation(reduceMotion ? nil : Motion.collapse, value: uploads.isEmpty)
        .animation(Motion.crossFade, value: failure)
        .animation(Motion.crossFade, value: holding)
        .animation(Motion.crossFade, value: queuedNote)
        .animation(Motion.crossFade, value: canAttach)
        .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
        .sensoryFeedback(.selection, trigger: holding) { _, now in now }
        .photosPicker(isPresented: $picking, selection: $picked, maxSelectionCount: max(1, Self.maxPhotos - uploads.count), matching: .images)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            add(items)
            picked = []
        }
        // The note says what happened to the last message; the turn ending says the rest.
        .onChange(of: turnOpen) { _, open in if !open { queuedNote = false } }
        // A hold whose text went (or whose turn ended) is no hold.
        .onChange(of: offersQueue) { _, offers in if !offers { holding = false } }
        .task(id: client.operateBlock) { await settleBlock() }
        // The row under the box names the catalog's models, for every key; a host that comes up asks again.
        .task(id: CatalogChoice.trigger(client)) { await choice.load(client) }
        #if DEBUG
        .task {
            guard TestHooks.open == "composer", block == nil else { return }
            try? await Task.sleep(for: .seconds(2))
            focused.wrappedValue = true
        }
        .onChange(of: draft, initial: true) {
            // The proof's `draft:`: the text lands as if typed and the keyboard comes up; nothing sends.
            guard let draft, block == nil else { return }
            text = draft
            focused.wrappedValue = true
        }
        // The Duo proof's fold run holds the typed draft (UTF-16 units) unchanged through every fold.
        .onChange(of: text, initial: true) { LayoutProbe.note("draftChars", String(text.utf16.count)) }
        #endif
        .task(id: session.map { "\($0.provider.rawValue)/\($0.model)/\($0.reasoning.rawValue)" }) {
            // The thread's own model lands (or changes under us): the choice follows it unless the person has a pick in hand.
            guard let session, !choice.picked else { return }
            choice.follow(session)
        }
    }

    /// The box, with this thread's field and button.
    private var box: some View {
        ComposerBox(placeholder: placeholder, text: field, focused: focused, blocked: block.map { $0.text(now: Date().timeIntervalSince1970 * 1000) }, canAttach: canAttach, attachEnabled: uploads.count < Self.maxPhotos, onAttach: { picking = true }) {
            ComposerButton(intent: intent, enabled: enabled, offersQueue: offersQueue, holding: $holding, reduced: reduceMotion, onTap: act, onQueue: queue)
        }
        .onChange(of: text) {
            failure = nil
            queuedNote = false
        }
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

    // MARK: send, steer, queue and pause

    /// The button's tap: what its glyph says.
    private func act() {
        switch intent {
        case .send: send()
        case .steer: steer()
        case .queue: queue()
        case .pause: pause()
        }
    }

    /// Into the live turn, as the desktop's composer steers (`queue.add
    /// { steer: true }`): the bubble's word says Sent, then Received.
    private func steer() {
        submit { body, settings, attachments in
            try await client.steer(sessionId, text: body, model: settings, attachments: attachments)
        }
    }

    /// A turn into a thread with none open.
    private func send() {
        submit { body, settings, attachments in
            try await client.send(sessionId, text: body, model: settings, attachments: attachments)
            // The person started this turn: it goes on the lock screen.
            if let session, session.parentId == nil { app.activities.sent(client, session, registry: app.registry) }
        }
    }

    /// For the next turn: the host's queue, the desktop's ⌘-click.
    private func queue() {
        submit { body, settings, attachments in
            if case .queued = try await client.queue(sessionId, text: body, model: settings, attachments: attachments) {
                queuedNote = true
            }
        }
    }

    /// The text, the pick and the photos go out together; a refusal gives
    /// all three back (photos picked meanwhile stay).
    private func submit(_ deliver: @escaping (String, TurnModel?, [Attachment]) async throws -> Void) {
        let body = trimmed
        guard !body.isEmpty || !uploads.isEmpty, !busy, photosSettled else { return }
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
                try await deliver(body, settings, attachments)
                // The pick went with the turn; the chips follow the thread's model again once its push lands.
                choice.release()
            } catch {
                text = body
                uploads = photos + uploads
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }

    private func pause() {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await client.pause(sessionId)
            } catch {
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }
}

/// The box's one button, the desktop's `SendButton`: a 28 pt circle on
/// prominent glass (the accent; the label color for Pause), the glyph what
/// a tap does, trading on the icon swap in the same frame so nothing moves
/// around it. Off, it is plain glass with a quiet glyph. Mid-turn with
/// text a press held past the system's long press turns the steer into a
/// queue: the queue glyph shows until release, and release queues; a
/// finger that slides away lets go of both. Its touch reaches 44 pt.
struct ComposerButton: View {
    let intent: ComposerIntent
    let enabled: Bool
    let offersQueue: Bool
    @Binding var holding: Bool
    let reduced: Bool
    /// The send is out (a draft's create): a spinner holds the glyph's place, the button off.
    var busy = false
    let onTap: () -> Void
    let onQueue: () -> Void
    @State private var pressed = false
    @State private var inside = true
    @State private var hold: Task<Void, Never>?
    /// 28 pt at the default text size, grown with the field's type up to the touch's 44.
    @ScaledMetric(relativeTo: .subheadline) private var scaledSide = ComposerMetrics.control
    private var side: CGFloat { ComposerMetrics.side(scaledSide) }
    private var outset: CGFloat { ComposerMetrics.hitOutset(side) }

    /// The glyph for an intent: the desktop's arrow, corner, list-plus and pause.
    static func symbol(_ intent: ComposerIntent) -> String {
        switch intent {
        case .send: "arrow.up"
        case .steer: "arrow.turn.down.right"
        case .queue: "text.badge.plus"
        case .pause: "pause.fill"
        }
    }

    private var tint: Color? {
        guard enabled else { return nil }
        return intent == .pause ? Color(.label) : Color.accentColor
    }

    private var glyphColor: Color {
        guard enabled else { return Color(.tertiaryLabel) }
        return intent == .pause ? Color(.systemBackground) : Color.white
    }

    var body: some View {
        ZStack {
            if busy {
                ProgressView()
                    .controlSize(.small)
                    .transition(Motion.iconSwap(reduced: reduced))
            } else {
                Image(systemName: Self.symbol(intent))
                    .font(.subheadline.weight(.semibold))
                    .dynamicTypeSize(...ComposerMetrics.glyphCap)
                    .foregroundStyle(glyphColor)
                    .id(intent)
                    .transition(Motion.iconSwap(reduced: reduced))
            }
        }
        .frame(width: side, height: side)
        .tcGlass(in: Circle(), tint: tint)
        .animation(reduced ? Motion.iconFade : Motion.iconSwap, value: intent)
        .animation(reduced ? Motion.iconFade : Motion.iconSwap, value: busy)
        .animation(Motion.crossFade, value: enabled)
        .scaleEffect(pressed && !reduced ? Motion.pressScale : 1)
        .opacity(pressed && reduced ? Motion.pressDim : 1)
        .animation(Motion.press, value: pressed)
        .padding(outset)
        .contentShape(Rectangle())
        .gesture(press)
        .padding(-outset)
        .accessibilityElement()
        .accessibilityLabel(busy ? "Sending" : intent.label)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { if enabled { onTap() } }
        .accessibilityActions {
            if offersQueue { Button(ComposerIntent.queue.label, action: onQueue) }
        }
    }

    /// One touch from down to up, in the 44 pt square it draws in.
    private var press: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let touch = side + 2 * outset
                let square = CGRect(origin: .zero, size: CGSize(width: touch, height: touch))
                inside = square.insetBy(dx: -outset, dy: -outset).contains(value.location)
                if !pressed {
                    pressed = true
                    startHold()
                }
                if !inside {
                    hold?.cancel()
                    holding = false
                }
                pressed = inside
            }
            .onEnded { _ in
                hold?.cancel()
                let queues = holding
                pressed = false
                holding = false
                guard inside else { inside = true; return }
                if queues { onQueue() } else if enabled { onTap() }
            }
    }

    private func startHold() {
        hold?.cancel()
        guard offersQueue, enabled else { return }
        hold = Task { @MainActor in
            try? await Task.sleep(for: .seconds(ComposerRules.queueHold))
            guard !Task.isCancelled, pressed, inside, offersQueue else { return }
            holding = true
        }
    }
}

/// The box itself, the one drawing a thread's composer and a project's
/// draft share: one glass shape at the field radius, `+` at the left (a bare
/// 28 pt glyph inside the box's glass, never glass on glass, its touch
/// reaching 44 pt, off once the turn holds four photos; at a larger text size
/// it and the button grow with the type up to 44 pt and their glyphs stop at
/// accessibility 1, so neither spills over the field), the field in the
/// prose type, and the caller's button at the right; the controls stay on
/// the bottom line as the field grows. `blocked` is the reason the key or
/// the link cannot act: it takes the placeholder's place, the field is
/// off, and `+` and the button leave. A tap on the padding focuses the field.
struct ComposerBox<Trailing: View>: View {
    let placeholder: String
    let text: Binding<String>
    let focused: FocusState<Bool>.Binding
    var blocked: String?
    var canAttach = true
    var attachEnabled = true
    let onAttach: () -> Void
    @ViewBuilder let button: Trailing
    /// `+` at the text size in use: 28 pt at the default, never past the touch's 44.
    @ScaledMetric(relativeTo: .subheadline) private var scaledSide = ComposerMetrics.control
    private var side: CGFloat { ComposerMetrics.side(scaledSide) }

    var body: some View {
        HStack(alignment: .bottom, spacing: ComposerMetrics.gap) {
            if canAttach {
                Button(action: onAttach) {
                    Image(systemName: "plus")
                        .font(.body.weight(.medium))
                        .dynamicTypeSize(...ComposerMetrics.glyphCap)
                        .foregroundStyle(attachEnabled ? Color.primary : Color(.tertiaryLabel))
                        .frame(width: side, height: side)
                        .padding(ComposerMetrics.hitOutset(side))
                        .contentShape(Rectangle())
                        .padding(-ComposerMetrics.hitOutset(side))
                }
                .buttonStyle(.pressable)
                .disabled(!attachEnabled)
                .accessibilityLabel("Add photos")
                .transition(.opacity)
            }
            TextField(blocked ?? placeholder, text: text, axis: .vertical)
                .transcriptType(TranscriptType.prose)
                .lineLimit(1...ComposerMetrics.maxLines)
                .focused(focused)
                .disabled(blocked != nil)
                .padding(.vertical, ComposerMetrics.fieldPad)
                .padding(.leading, canAttach ? 0 : ComposerMetrics.gap)
                .frame(minHeight: side)
                .accessibilityLabel(blocked ?? "Message")
            if blocked == nil {
                button
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, ComposerMetrics.inset)
        .padding(.vertical, ComposerMetrics.edge)
        .frame(maxWidth: .infinity, alignment: .leading)
        .tcGlass(in: RoundedRectangle.corner(ComposerMetrics.radius))
        .contentShape(RoundedRectangle.corner(ComposerMetrics.radius))
        .onTapGesture { if blocked == nil { focused.wrappedValue = true } }
    }
}
