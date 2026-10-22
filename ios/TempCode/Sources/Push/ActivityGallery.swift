#if DEBUG
import SwiftUI
import TempCodeContract
import UIKit

/// The simulator proof's view of the Live Activity: every phase's lock
/// screen card and the Dynamic Island's expanded and compact presentations,
/// drawn with the extension's own views over the app
/// (`TC_TEST_ACTIVITY_GALLERY=1`, or one phase's name). The system's lock
/// screen and island cannot be driven from a script on a Mac without a
/// device window, so this is what a screenshot of each state comes from;
/// the real presentations use the same views (Activity/Shared).
enum ActivityGallery {
    static let attributes = ThreadActivityAttributes(environmentId: "env_proof", sessionId: "ios-running", title: "Add the billing export", threadType: .implementation)
    /// A watching master: its card counts the batch's threads and names the engine's step.
    static let masterAttributes = ThreadActivityAttributes(environmentId: "env_proof", sessionId: "ios-master", title: "Release 1.0.281", threadType: .chat)

    /// A host-shaped state for a phase, two minutes into the work, with or without a task list;
    /// `threads` makes it a master's batch tally (`unit: threads`, the running step as the line).
    static func sample(phase: ThreadActivityAttributes.Phase, tasks: Bool, threads: Bool = false, now: Date = .now) -> ThreadActivityAttributes.ContentState {
        let ms = Int(now.timeIntervalSince1970 * 1000)
        let since = ms - (phase == .finished ? 12 * 60_000 + 4_000 : 2 * 60_000 + 22_000)
        if threads {
            let title = masterAttributes.title
            switch phase {
            case .working: return .init(phase: .working, since: since, ts: ms, seq: 12, title: title, task: "gate", done: 3, total: 4, unit: .threads)
            case .paused: return .init(phase: .paused, since: since, ts: ms, seq: 12, title: title, task: "Waiting on 2 threads", done: 2, total: 4, unit: .threads)
            case .waiting: return .init(phase: .waiting, since: since, ts: ms, seq: 13, title: title, task: "Waiting on 2 threads", done: 2, total: 4, unit: .threads, reason: "Asked: Land the batch now?")
            case .finished: return .init(phase: .finished, since: since, ts: ms, seq: 20, title: title, done: 4, total: 4, unit: .threads)
            case .failed: return .init(phase: .failed, since: since, ts: ms, seq: 18, title: title, task: "gate", done: 4, total: 4, unit: .threads)
            case .stopped: return .init(phase: .stopped, since: since, ts: ms, seq: 18, title: title, task: "gate", done: 3, total: 4, unit: .threads)
            }
        }
        switch phase {
        case .working:
            return .init(phase: .working, since: since, ts: ms, seq: 41, title: attributes.title, task: tasks ? "Write the export endpoint" : "Editing export.ts", done: tasks ? 1 : nil, total: tasks ? 3 : nil)
        case .paused:
            return .init(phase: .paused, since: since, ts: ms, seq: 41, title: attributes.title, task: tasks ? "Write the export endpoint" : "Editing export.ts", done: tasks ? 1 : nil, total: tasks ? 3 : nil)
        case .waiting:
            return .init(phase: .waiting, since: since, ts: ms, seq: 42, title: attributes.title, task: tasks ? "Write the export endpoint" : nil, done: tasks ? 1 : nil, total: tasks ? 3 : nil, reason: "Needs approval: Bash — bun test")
        case .finished:
            return .init(phase: .finished, since: since, ts: ms, seq: 60, title: attributes.title, done: tasks ? 3 : nil, total: tasks ? 3 : nil)
        case .failed:
            return .init(phase: .failed, since: since, ts: ms, seq: 44, title: attributes.title, task: tasks ? "Write the export endpoint" : nil, done: tasks ? 1 : nil, total: tasks ? 3 : nil)
        case .stopped:
            return .init(phase: .stopped, since: since, ts: ms, seq: 44, title: attributes.title, task: tasks ? "Write the export endpoint" : nil, done: tasks ? 1 : nil, total: tasks ? 3 : nil)
        }
    }

    private static var window: UIWindow?

    /// Opens the gallery over whatever the app shows, in its own window.
    static func present() {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
        let spec = ProcessInfo.processInfo.environment["TC_TEST_ACTIVITY_GALLERY"] ?? "1"
        let phases: [ThreadActivityAttributes.Phase] = ThreadActivityAttributes.Phase(rawValue: spec).map { [$0] } ?? ThreadActivityAttributes.Phase.allCases
        let tasks = ProcessInfo.processInfo.environment["TC_TEST_ACTIVITY_NOTASKS"] != "1"
        let threads = ProcessInfo.processInfo.environment["TC_TEST_ACTIVITY_THREADS"] == "1"
        let window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: ActivityGalleryView(phases: phases, tasks: tasks, threads: threads))
        window.windowLevel = .alert + 1
        window.makeKeyAndVisible()
        self.window = window
    }
}

struct ActivityGalleryView: View {
    let phases: [ThreadActivityAttributes.Phase]
    let tasks: Bool
    /// Every phase as a master's batch (`TC_TEST_ACTIVITY_THREADS=1`); otherwise one working master closes the list.
    var threads = false

    private var samples: [(label: String, attributes: ThreadActivityAttributes, state: ThreadActivityAttributes.ContentState)] {
        let own = phases.map { phase in
            (label: threads ? "\(phase.rawValue) · threads" : phase.rawValue,
             attributes: threads ? ActivityGallery.masterAttributes : ActivityGallery.attributes,
             state: ActivityGallery.sample(phase: phase, tasks: tasks, threads: threads))
        }
        guard !threads, phases.count > 1 else { return own }
        return own + [(label: "working · threads", attributes: ActivityGallery.masterAttributes, state: ActivityGallery.sample(phase: .working, tasks: true, threads: true))]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                ForEach(samples, id: \.label) { sample in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(sample.label)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .textCase(.uppercase)
                        LockScreenFrame {
                            ThreadActivityCard(attributes: sample.attributes, state: sample.state)
                        }
                        IslandExpandedFrame(attributes: sample.attributes, state: sample.state)
                        HStack(spacing: 12) {
                            IslandCompactFrame(attributes: sample.attributes, state: sample.state)
                            IslandMinimalFrame(attributes: sample.attributes, state: sample.state)
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 24)
        }
        .background(Color(.systemBackground))
    }
}

/// The lock screen's banner material, at the width the lock screen gives it.
private struct LockScreenFrame<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        content
            .frame(width: 361)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(Color(.secondarySystemBackground)))
    }
}

/// The island's black, with its regions laid out the way the widget lays them out.
private struct IslandExpandedFrame: View {
    let attributes: ThreadActivityAttributes
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                TypeGlyph(type: attributes.threadType, weight: .semibold)
                    .padding(.leading, 4)
                Text(state.title ?? attributes.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 8)
                ActivityElapsedText(state: state)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.trailing, 4)
            }
            ActivityExpandedBottom(type: attributes.threadType, state: state)
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 16)
        .frame(width: 371)
        .background(Color.black, in: RoundedRectangle(cornerRadius: 44, style: .continuous))
        .environment(\.colorScheme, .dark)
    }
}

private struct IslandCompactFrame: View {
    let attributes: ThreadActivityAttributes
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 0) {
            ActivityCompactLeading(type: attributes.threadType, state: state)
                .padding(.leading, 10)
            Spacer(minLength: 0)
            ActivityCompactTrailing(type: attributes.threadType, state: state)
                .padding(.trailing, 14)
        }
        .frame(width: 236, height: 37)
        .background(Color.black, in: Capsule())
        .environment(\.colorScheme, .dark)
    }
}

private struct IslandMinimalFrame: View {
    let attributes: ThreadActivityAttributes
    let state: ThreadActivityAttributes.ContentState

    var body: some View {
        ActivityMinimal(type: attributes.threadType, state: state)
            .frame(width: 37, height: 37)
            .background(Color.black, in: Capsule())
            .environment(\.colorScheme, .dark)
    }
}
#endif
