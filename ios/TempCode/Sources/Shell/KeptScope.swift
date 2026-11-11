import Observation
import SwiftUI
import TempCodeClient

/// A project shell's scope and its strip, kept between passes and worked
/// out off the bodies that draw them. The shell and the strip once built
/// both in their bodies from every host's sessions and seen marks, so any
/// meta from any thread on any host ran them, and with them the thread
/// screen they hold. Here the answer is computed from the hosts' current
/// sessions (`HomeRows.inputs(current:)`, read with nothing tracked) at the
/// first ask for a key, and again by `follow`, which waits on the hosts'
/// `liveRevision` in a task. A view reads one of three parts, each behind
/// its own tick, moved only when that part changed:
///
/// - `summary`: that the scope exists, its name, its lead and its archived
///   counts (the shell; the strip's New Thread and Recent menu);
/// - `strip`: the chips, by what the strip draws of them (`StripModel.drawn`):
///   a meta that changes no chip's look moves nothing;
/// - `scope`: the whole scope, for the draft shown while no thread is open.
///
/// No tracked property is written while a body runs: an ask from a body
/// fills plain storage, and only `follow` moves the ticks.
@Observable
final class KeptScope {
    struct Summary: Equatable {
        var key: String
        var name: String
        var lead: StripScope.Lead?
        var archived: [HomeSections.ArchivedThreads]
    }

    private struct Held {
        /// The shell's key and the thread on screen ("<environment>:<session>") it was worked out for.
        var key: String
        var thread: String?
        var scope: StripScope?
        var summary: Summary?
        var strip: StripModel?
    }

    private var summaryTick = 0
    private var stripTick = 0
    private var scopeTick = 0
    @ObservationIgnored private var held: Held?

    func summary(key: String, thread: String?, registry: ClientRegistry) -> Summary? {
        _ = summaryTick
        return ensure(key, thread, registry).summary
    }

    func strip(key: String, thread: String?, registry: ClientRegistry) -> StripModel? {
        _ = stripTick
        return ensure(key, thread, registry).strip
    }

    func scope(key: String, thread: String?, registry: ClientRegistry) -> StripScope? {
        _ = scopeTick
        return ensure(key, thread, registry).scope
    }

    /// What is held for the key and thread, worked out now when it is for another.
    private func ensure(_ key: String, _ thread: String?, _ registry: ClientRegistry) -> Held {
        if let held, held.key == key, held.thread == thread { return held }
        let made = Self.compute(key: key, thread: thread, registry: registry)
        held = made
        return made
    }

    private static func compute(key: String, thread: String?, registry: ClientRegistry) -> Held {
        let hosts = HomeRows.inputs(registry.ordered, current: true)
        let scope = ThreadStrip.scope(key: key, hosts: hosts)
        let strip = scope.map { scope in
            ThreadStrip.model(scope: scope, shown: thread.flatMap(ShellPaths.split), order: ThreadStripStore.shared.order(scope.key), hosts: hosts, sending: ProjectDraftStore.shared.sending[scope.key])
        }
        let summary = scope.map { Summary(key: $0.key, name: $0.name, lead: $0.lead, archived: $0.archived) }
        return Held(key: key, thread: thread, scope: scope, summary: summary, strip: strip)
    }

    /// Keeps the parts current while the shell shows this key and thread:
    /// each time a host's sessions or seen marks move (or its lists, or a
    /// draft's send), the answer is worked out again, once a frame at most,
    /// and a part's readers run only when that part changed.
    func follow(key: String, thread: String?, registry: ClientRegistry) async {
        while !Task.isCancelled {
            let (changed, signal) = AsyncStream<Void>.makeStream()
            let next = withObservationTracking {
                for client in registry.ordered { _ = client.liveRevision }
                return Self.compute(key: key, thread: thread, registry: registry)
            } onChange: {
                signal.yield()
                signal.finish()
            }
            apply(next)
            for await _ in changed { break }
            try? await Task.sleep(for: .milliseconds(16))
        }
    }

    private func apply(_ next: Held) {
        guard let now = held else {
            held = next
            return
        }
        // The body has moved on to another key or thread: what it holds is its own.
        guard now.key == next.key, now.thread == next.thread else { return }
        held = next
        if now.summary != next.summary { summaryTick += 1 }
        if now.strip?.drawn != next.strip?.drawn { stripTick += 1 }
        if now.scope != next.scope { scopeTick += 1 }
    }
}
