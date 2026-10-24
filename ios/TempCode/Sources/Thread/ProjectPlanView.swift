import SwiftUI
import TempCodeClient
import TempCodeContract

/// A project-plan thread's Plan segment (docs/PROJECT-PLAN.md): the plan
/// file as the document, with `## Milestones` replaced by native rows (a
/// checkbox the person ticks over `projectPlan.tick`, the ordinal, the
/// title, the scope line, done-when and the dependency chips on expand),
/// a 3 pt progress line under the heading, and the options card once the
/// frontmatter says `status: complete`. Composed on the plan page: the
/// fixed sections render through `PlanDocumentView(range:)`, nothing here
/// renders markdown of its own, and the block ids stay the document's.
struct ProjectPlanView: View {
    let client: EnvironmentClient
    let sessionId: String
    let session: SessionMeta?
    /// The polled file (ThreadScreenModel).
    let document: String?
    let running: Bool

    @Environment(\.markdownScope) private var scope
    @State private var model = ProjectPlanModel()
    @State private var pushed: ThreadScreenRoute?
    @State private var sheet: MilestoneStartTarget?
    @State private var revising = false
    @State private var hooked = false

    private var key: String { ThreadCaches.planKey(scope.environmentId, sessionId) }
    private var text: String? { document ?? ThreadCaches.plans.cached(key) }
    private var projectId: String? { session?.projectId }

    var body: some View {
        PlanPage(key: key, text: text, running: running, cache: document != nil) { doc in
            VStack(alignment: .leading, spacing: PlanType.gap) {
                ForEach(doc.sections(level: 2), id: \.blocks.lowerBound) { section in
                    if Self.isMilestones(section) {
                        // The `## Milestones` heading block alone, so it looks like every other heading.
                        PlanDocumentView(document: doc, range: section.blocks.lowerBound..<(section.blocks.lowerBound + 1))
                        milestones
                    } else {
                        PlanDocumentView(document: doc, range: section.blocks)
                    }
                }
                if model.plan.isComplete {
                    card
                        .padding(.top, ProjectPlanType.cardAbove)
                        .rowAppearTransition()
                }
            }
            .animation(Motion.rowAppear, value: model.plan.isComplete)
        }
        .onChange(of: text, initial: true) { _, now in model.update(text: now) }
        // DEBUG proof: `TC_TEST_SHEET=milestone` opens Plan the milestone for the first undone one.
        .onChange(of: model.next, initial: true) { _, next in
            guard TestHooks.sheet == "milestone", !hooked, let next else { return }
            hooked = true
            sheet = MilestoneStartTarget(kind: .planning, milestone: next)
        }
        .task(id: projectId) {
            guard let projectId else { return }
            if let cached = ThreadCaches.projectPlans.state(scope.environmentId, projectId) { model.adopt(cached) }
            await model.load(client, projectId: projectId)
        }
        .onChange(of: session?.status) { _, status in
            // plan_complete lands at the end of the plan thread's turn: the state follows.
            guard status == .idle || status == .done, let projectId else { return }
            Task { await model.load(client, projectId: projectId) }
        }
        .sheet(item: $sheet) { target in
            if let session {
                MilestoneStartSheet(client: client, plan: session, milestone: target.milestone, kind: target.kind, model: model) { built, linkError in
                    model.error = linkError
                    pushed = ThreadScreenRoute(sessionId: built.id)
                }
            }
        }
        .reviseAlert(isPresented: $revising) { ask in
            Task { await model.revise(client, sessionId: sessionId, ask: ask) }
        }
        .navigationDestination(item: $pushed) { route in
            ThreadScreen(client: client, sessionId: route.sessionId, performsLaunchAction: false)
        }
    }

    private static func isMilestones(_ section: PlanDocument.Section) -> Bool {
        String(section.heading.characters).trimmingCharacters(in: .whitespaces).lowercased() == "milestones"
    }

    private var blocked: String? {
        client.operateBlock?.text(now: Date().timeIntervalSince1970 * 1000)
    }

    /// The progress line, the read-key reason when there is one, and the rows.
    private var milestones: some View {
        let progress = model.progress
        return VStack(alignment: .leading, spacing: 0) {
            MilestoneHeader(done: progress.done, total: progress.total, blocked: blocked)
            ForEach(model.plan.milestones) { milestone in
                MilestoneRow(
                    milestone: milestone,
                    done: model.done(milestone),
                    expanded: model.expanded == milestone.index,
                    busy: model.busy == .tick(milestone.index),
                    disabled: blocked != nil || model.busy != nil || projectId == nil,
                    onTick: {
                        guard let projectId else { return }
                        Task { await model.tick(client, projectId: projectId, milestone) }
                    },
                    onToggle: { model.expanded = model.expanded == milestone.index ? nil : milestone.index }
                )
            }
        }
    }

    private var card: some View {
        ProjectPlanCard(
            done: model.progress.done,
            total: model.progress.total,
            next: model.next,
            pinned: model.state?.pinned ?? false,
            busy: model.busy,
            canStart: session != nil && projectId != nil,
            canPin: projectId != nil,
            footer: blocked ?? model.error,
            isBlocked: blocked != nil,
            onPlan: { next in sheet = MilestoneStartTarget(kind: .planning, milestone: next) },
            onOrchestrate: { next in sheet = MilestoneStartTarget(kind: .orchestration, milestone: next) },
            onRevise: { revising = true },
            onPin: {
                guard let projectId else { return }
                Task { await model.pin(client, projectId: projectId) }
            }
        )
    }
}

// MARK: - the model

/// What the screen holds beyond the document: the parsed plan, the
/// optimistic ticks until the file catches up, the host's state around the
/// file (pin, thread), the one expanded row, the action in flight and the
/// last refusal. Main actor (the app target's default).
@Observable
final class ProjectPlanModel {
    enum Busy: Hashable {
        case tick(Int)
        case plan
        case orchestrate
        case revise
        case pin
    }

    private(set) var plan = ProjectPlan.Document()
    /// Ticks the person made that the file has not shown yet, by milestone index.
    private(set) var overlay: [Int: Bool] = [:]
    /// `projectPlan.get`; nil until loaded, or on a host without project plans.
    private(set) var state: ProjectPlanState?
    var expanded: Int?
    var busy: Busy?
    /// The last refusal, shown under the card until the next action.
    var error: String?
    @ObservationIgnored private var textHash: Int?

    /// Re-parses when the text changed; the overlay drops what the document now agrees with.
    func update(text: String?) {
        let hash = text?.hashValue
        guard hash != textHash else { return }
        textHash = hash
        plan = text.map(ProjectPlan.parse) ?? ProjectPlan.Document()
        overlay = ProjectPlan.reconcile(overlay: overlay, with: plan.milestones)
        if let expanded, !plan.milestones.contains(where: { $0.index == expanded }) { self.expanded = nil }
    }

    func done(_ milestone: ProjectPlan.Milestone) -> Bool {
        overlay[milestone.index] ?? milestone.done
    }

    /// A state another surface already holds (the Home chip's cache).
    func adopt(_ state: ProjectPlanState?) {
        self.state = state
    }

    var progress: (done: Int, total: Int) {
        (plan.milestones.filter(done).count, plan.milestones.count)
    }

    /// The first milestone not done, the overlay counted.
    var next: ProjectPlan.Milestone? {
        plan.milestones.first { !done($0) }
    }

    /// The state around the file. A host without the method (older) leaves
    /// it nil: the pin row then reads "Keep as the project's plan" and the
    /// ticks still work, the file being the truth.
    func load(_ client: EnvironmentClient, projectId: String) async {
        do {
            state = try await client.request(Methods.ProjectPlanGet.self, .init(projectId: projectId))
        } catch {
            // An older host, or the link is down: nothing to show beyond the file.
        }
    }

    func tick(_ client: EnvironmentClient, projectId: String, _ milestone: ProjectPlan.Milestone) async {
        guard busy == nil else { return }
        let want = !done(milestone)
        busy = .tick(milestone.index)
        error = nil
        defer { busy = nil }
        do {
            let answer = try await client.request(Methods.ProjectPlanTick.self, .init(projectId: projectId, milestone: milestone.index, done: want))
            if answer.ticked {
                overlay[milestone.index] = want
                // The poll may have landed the file between the host's write and this answer.
                overlay = ProjectPlan.reconcile(overlay: overlay, with: plan.milestones)
            } else {
                error = "The plan file has no milestone \(milestone.index)"
            }
            state = answer.state
            ThreadCaches.projectPlans.set(client, projectId: projectId, state)
        } catch {
            self.error = Self.message(of: error)
        }
    }

    func pin(_ client: EnvironmentClient, projectId: String) async {
        guard busy == nil else { return }
        busy = .pin
        error = nil
        defer { busy = nil }
        do {
            state = try await client.request(Methods.ProjectPlanPin.self, .init(projectId: projectId, pinned: !(state?.pinned ?? false)))
            ThreadCaches.projectPlans.set(client, projectId: projectId, state)
        } catch {
            self.error = Self.message(of: error)
        }
    }

    /// "Revise the plan": a new turn in the plan thread; the segment stays on
    /// Plan and the document updates in place as the planner edits it.
    func revise(_ client: EnvironmentClient, sessionId: String, ask: String) async {
        guard busy == nil else { return }
        busy = .revise
        error = nil
        defer { busy = nil }
        do {
            try await client.send(sessionId, text: ProjectPlan.reviseText(ask))
        } catch {
            self.error = Self.message(of: error)
        }
    }

    static func message(of error: any Error) -> String {
        if let action = error as? ActionError { return action.message }
        if let transport = error as? TransportError, case .server(_, let message) = transport { return message }
        return String(describing: error)
    }
}

// MARK: - the progress line

/// Under the `## Milestones` heading: a 3 pt capsule filled to done of
/// total, the count beside it in the stamp step, and the reason a read key
/// cannot tick when there is one. No percentage.
private struct MilestoneHeader: View {
    let done: Int
    let total: Int
    let blocked: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: ProjectPlanType.progressBelowHeading) {
            HStack(spacing: 10) {
                ProgressTrack(done: done, total: total)
                Text("\(done) of \(total) done")
                    .textStep(.stamp)
                    .numeric(done)
                    .fixedSize()
            }
            .animation(reduceMotion ? nil : Motion.expand, value: done)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(done) of \(total) milestones done")
            if let blocked {
                Text(blocked)
                    .textStep(.meta)
            }
        }
        .padding(.bottom, ProjectPlanType.progressBelow)
    }
}

/// The track alone sits in the geometry reader, never text.
private struct ProgressTrack: View {
    let done: Int
    let total: Int

    var body: some View {
        GeometryReader { proxy in
            Capsule()
                .fill(Surface.fill)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(Tint.success)
                        .frame(width: proxy.size.width * CGFloat(done) / CGFloat(max(total, 1)))
                }
        }
        .frame(height: ProjectPlanType.progressHeight)
    }
}

// MARK: - a milestone row

/// One milestone: the checkbox in the marker column, the ordinal in its own
/// column, the title with the scope as one dim truncated line, and on tap
/// the done-when and the dependency chips. A hairline below, at the text
/// edge. The glyph and the title's color say done; nothing is struck through.
private struct MilestoneRow: View {
    let milestone: ProjectPlan.Milestone
    let done: Bool
    let expanded: Bool
    /// This row's tick is in flight.
    let busy: Bool
    /// A read key, the socket down, or another action in flight.
    let disabled: Bool
    let onTick: () -> Void
    let onToggle: () -> Void

    @ScaledMetric(relativeTo: .body) private var column = ProjectPlanType.checkboxColumn
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Where the title starts: the checkbox column, the ordinal column and its gap.
    private var textEdge: CGFloat { column * 2 + ProjectPlanType.ordinalGap }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                checkbox
                    .frame(width: column, alignment: .center)
                Text("\(milestone.index).")
                    .textStep(.meta)
                    .monospacedDigit()
                    .frame(width: column, alignment: .trailing)
                    .padding(.trailing, ProjectPlanType.ordinalGap)
                    .accessibilityHidden(true)
                text
            }
            .padding(.vertical, ProjectPlanType.rowVertical)
            .frame(minHeight: ProjectPlanType.rowMinHeight, alignment: .leading)
            Hairline(inset: textEdge)
        }
        .animation(reduceMotion ? Motion.crossFade : (expanded ? Motion.expand : Motion.collapse), value: expanded)
        .sensoryFeedback(.impact(weight: .light), trigger: done)
    }

    private var checkbox: some View {
        Button(action: onTick) {
            ZStack {
                if busy {
                    ProgressView()
                        .controlSize(.small)
                        .iconSwapTransition()
                } else {
                    Image(systemName: done ? "checkmark.circle.fill" : "circle")
                        .font(ProjectPlanType.checkboxGlyph)
                        .foregroundStyle(done ? AnyShapeStyle(Tint.success) : AnyShapeStyle(Color(.tertiaryLabel)))
                        .id(done)
                        .iconSwapTransition()
                }
            }
            .animation(reduceMotion ? Motion.iconFade : Motion.iconSwap, value: done)
            .frame(width: ProjectPlanType.checkboxHit, height: ProjectPlanType.checkboxHit)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .disabled(disabled || busy)
        .accessibilityLabel("Milestone \(milestone.index): \(milestone.title), \(done ? "done" : "not done")")
        .accessibilityHint(done ? "Marks the milestone not done" : "Marks the milestone done")
    }

    @ViewBuilder
    private var text: some View {
        if milestone.hasDetails {
            Button(action: onToggle) {
                lines
                    .contentShape(Rectangle())
            }
            .buttonStyle(.pressable)
            .accessibilityElement(children: .combine)
            .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            .accessibilityHint(expanded ? "Hides the details" : "Shows the details")
        } else {
            lines
        }
    }

    private var lines: some View {
        VStack(alignment: .leading, spacing: ProjectPlanType.detailGap) {
            Text(milestone.title)
                .font(ProjectPlanType.titleFont)
                .foregroundStyle(done ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                .animation(Motion.crossFade, value: done)
            if let scope = milestone.scope {
                Text(scope)
                    .font(ProjectPlanType.detailFont)
                    .foregroundStyle(.secondary)
                    .lineLimit(expanded ? nil : 1)
            }
            if expanded {
                Group {
                    if let doneWhen = milestone.doneWhen {
                        (Text("Done when ").font(ProjectPlanType.detailLabelFont) + Text(doneWhen).font(ProjectPlanType.detailFont))
                            .foregroundStyle(.secondary)
                    }
                    let chips = ProjectPlan.dependencyChips(milestone.dependencies)
                    if !chips.isEmpty {
                        DependencyChips(chips: chips)
                    }
                }
                .transition(.opacity.animation(Motion.expandContent))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// "Depends on" and one capsule per milestone number, scrolling sideways
/// when they overflow the row.
private struct DependencyChips: View {
    let chips: [String]
    @ScaledMetric(relativeTo: .caption2) private var height = ProjectPlanType.chipHeight

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: ProjectPlanType.chipGap) {
                Text("Depends on")
                    .font(ProjectPlanType.chipFont)
                    .foregroundStyle(.secondary)
                ForEach(chips, id: \.self) { chip in
                    Text(chip)
                        .font(ProjectPlanType.chipFont)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, ProjectPlanType.chipPadding)
                        .frame(height: height)
                        .background(Surface.fill, in: Capsule())
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Depends on \(chips.joined(separator: ", "))")
    }
}

// MARK: - the options card

/// After `status: complete`: what to do with the plan. Four rows in the
/// group card; blocked (a read key, the socket down) disables them and the
/// footer says why; the last refusal reads there too.
private struct ProjectPlanCard: View {
    let done: Int
    let total: Int
    let next: ProjectPlan.Milestone?
    let pinned: Bool
    let busy: ProjectPlanModel.Busy?
    let canStart: Bool
    let canPin: Bool
    let footer: String?
    let isBlocked: Bool
    let onPlan: (ProjectPlan.Milestone) -> Void
    let onOrchestrate: (ProjectPlan.Milestone) -> Void
    let onRevise: () -> Void
    let onPin: () -> Void

    private var locked: Bool { busy != nil || isBlocked }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text("The plan is complete")
                    .textStep(.title, weight: .semibold)
                Spacer(minLength: 12)
                Text("\(done) of \(total) done")
                    .textStep(.stamp)
                    .numeric(done)
            }
            .padding(.horizontal, ProjectPlanType.cardInset)
            .frame(minHeight: ProjectPlanType.cardRowMinHeight)
            Hairline()
            CardAction(
                systemName: "map",
                tint: Tint.violet,
                title: "Plan the next milestone",
                detail: next.map { "\($0.index). \($0.title)" } ?? "Every milestone is done",
                busy: busy == .plan,
                disabled: locked || next == nil || !canStart
            ) { if let next { onPlan(next) } }
            Hairline(inset: ProjectPlanType.cardInset + ProjectPlanType.glyphColumn + Layout.rowGap)
            CardAction(
                systemName: "arrow.triangle.branch",
                tint: Tint.warning,
                title: next.map { "Start an orchestration thread for milestone \($0.index)" } ?? "Start an orchestration thread",
                detail: "Split the milestone across subagents",
                busy: busy == .orchestrate,
                disabled: locked || next == nil || !canStart
            ) { if let next { onOrchestrate(next) } }
            Hairline(inset: ProjectPlanType.cardInset + ProjectPlanType.glyphColumn + Layout.rowGap)
            CardAction(
                systemName: "pencil",
                tint: Color(.secondaryLabel),
                title: "Revise the plan",
                detail: "A new turn in this thread",
                busy: busy == .revise,
                disabled: locked,
                action: onRevise
            )
            Hairline(inset: ProjectPlanType.cardInset + ProjectPlanType.glyphColumn + Layout.rowGap)
            CardAction(
                systemName: pinned ? "pin.slash" : "pin",
                tint: pinned ? Color(.secondaryLabel) : Tint.info,
                title: pinned ? "Stop keeping as the project's plan" : "Keep as the project's plan",
                detail: pinned ? "The project header shows its milestones" : "Shown in the project header, ticked as builds land",
                busy: busy == .pin,
                disabled: locked || !canPin,
                action: onPin
            )
            if let footer {
                Text(footer)
                    .textStep(.meta, tint: isBlocked ? nil : Tint.destructive)
                    .padding(.horizontal, ProjectPlanType.cardInset)
                    .padding(.top, 8)
                    .padding(.bottom, ProjectPlanType.cardInset)
            }
        }
        .groupCard(radius: ProjectPlanType.cardRadius)
        .accessibilityElement(children: .contain)
    }
}

/// One option: the glyph in its column (a small spinner while that action
/// runs), the title and a one-line detail. Scales on press.
private struct CardAction: View {
    let systemName: String
    let tint: Color
    let title: String
    let detail: String
    let busy: Bool
    let disabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: Layout.rowGap) {
                ZStack {
                    if busy {
                        ProgressView()
                            .controlSize(.small)
                            .iconSwapTransition()
                    } else {
                        Image(systemName: systemName)
                            .font(.subheadline)
                            .foregroundStyle(tint)
                            .id(systemName)
                            .iconSwapTransition()
                    }
                }
                .animation(Motion.iconSwap, value: busy)
                .frame(width: ProjectPlanType.glyphColumn)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .textStep(.title)
                    Text(detail)
                        .textStep(.meta)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, ProjectPlanType.cardInset)
            .padding(.vertical, 8)
            .frame(minHeight: ProjectPlanType.cardRowMinHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.pressable)
        .disabled(disabled)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - revise

extension View {
    /// "Revise the plan": a text field for what should change; empty sends
    /// the desktop's default turn, which re-surveys the project.
    func reviseAlert(isPresented: Binding<Bool>, send: @escaping (String) -> Void) -> some View {
        modifier(ReviseAlert(isPresented: isPresented, send: send))
    }
}

private struct ReviseAlert: ViewModifier {
    @Binding var isPresented: Bool
    let send: (String) -> Void
    @State private var ask = ""

    func body(content: Content) -> some View {
        content.alert("Revise the plan", isPresented: $isPresented) {
            TextField("What should change?", text: $ask)
            Button("Send") {
                send(ask)
                ask = ""
            }
            Button("Cancel", role: .cancel) { ask = "" }
        } message: {
            Text("Empty re-surveys the project and updates the plan.")
        }
    }
}

// MARK: - start a milestone

/// What the sheet starts: a planning thread for the milestone, or an
/// orchestration thread that works it straight from the plan.
struct MilestoneStartTarget: Identifiable, Hashable {
    let kind: ThreadDraft.MilestoneKind
    let milestone: ProjectPlan.Milestone

    var id: String { "\(kind):\(milestone.index)" }
}

/// "Plan the next milestone" / "Start an orchestration thread for milestone
/// N": the milestone, then who runs it and how hard it thinks, prefilled
/// from the plan thread. Start creates the thread with its brief, links it
/// to the milestone over `projectPlan.link`, and pushes it. A link that
/// fails after the create still opens the thread (it exists); the failure
/// comes back beside it.
struct MilestoneStartSheet: View {
    let client: EnvironmentClient
    let plan: SessionMeta
    let milestone: ProjectPlan.Milestone
    let kind: ThreadDraft.MilestoneKind
    let model: ProjectPlanModel?
    let onStarted: (SessionMeta, String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var choice: CatalogChoice
    @State private var busy = false
    @State private var error: String?

    init(client: EnvironmentClient, plan: SessionMeta, milestone: ProjectPlan.Milestone, kind: ThreadDraft.MilestoneKind, model: ProjectPlanModel? = nil, onStarted: @escaping (SessionMeta, String?) -> Void) {
        self.client = client
        self.plan = plan
        self.milestone = milestone
        self.kind = kind
        self.model = model
        self.onStarted = onStarted
        _choice = State(initialValue: CatalogChoice(provider: plan.provider, model: plan.model, reasoning: plan.reasoning))
    }

    private var type: ThreadType { kind == .planning ? .planning : .orchestration }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Image(systemName: type.symbol)
                            .font(.subheadline)
                            .foregroundStyle(type.tint)
                            .frame(width: ProjectPlanType.glyphColumn)
                        VStack(alignment: .leading, spacing: ProjectPlanType.detailGap) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("M\(milestone.index)")
                                    .font(.footnote.weight(.medium))
                                    .monospacedDigit()
                                    .foregroundStyle(.tertiary)
                                Text(milestone.title)
                                    .font(.body)
                            }
                            if let scope = milestone.scope {
                                Text(scope)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                            if let doneWhen = milestone.doneWhen {
                                (Text("Done when ").font(ProjectPlanType.detailLabelFont) + Text(doneWhen).font(.footnote))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                Section {
                    ModelReasoningRows(client: client, choice: choice)
                } footer: {
                    if let error {
                        Text(error)
                            .foregroundStyle(Tint.destructive)
                    }
                }
            }
            .navigationTitle(kind == .planning ? "Plan the milestone" : "Orchestrate the milestone")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Start") { Task { await start() } }
                            .disabled(choice.catalog == nil && choice.loading)
                    }
                }
                .highVisibility()
            }
            .interactiveDismissDisabled(busy)
        }
        .tcSheet(.form)
    }

    private func start() async {
        guard !busy else { return }
        busy = true
        error = nil
        model?.busy = kind == .planning ? .plan : .orchestrate
        defer {
            busy = false
            model?.busy = nil
        }
        guard let draft = ThreadDraft.milestone(from: plan, milestone: milestone, kind: kind, provider: choice.key.provider, model: choice.key.model, reasoning: choice.reasoning), let projectId = plan.projectId else {
            error = "The plan has no file or project"
            return
        }
        let built: SessionMeta
        do {
            built = try await client.createThread(draft)
        } catch {
            self.error = ProjectPlanModel.message(of: error)
            return
        }
        var linkError: String?
        do {
            try await client.request(Methods.ProjectPlanLink.self, .init(sessionId: built.id, projectId: projectId, milestone: milestone.index))
        } catch {
            linkError = "Started, but the milestone link failed: \(ProjectPlanModel.message(of: error))"
        }
        if let model { await model.load(client, projectId: projectId) }
        dismiss()
        onStarted(built, linkError)
    }
}
