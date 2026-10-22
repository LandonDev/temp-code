import Foundation
import Observation
import TempCodeContract

/// Thread resources on the phone (docs/box.md "Thread resources"): the
/// ledger of what a thread created (worktrees, simulators, dev instances) on
/// its host or on the Mac, read over `resources.list` and `resources.listAll`
/// and kept current by the host's `resources` push. The Resources sheet
/// removes one row at a time; archiving with the switch on passes
/// `removeResources` to `session.archive`.
@MainActor @Observable
public final class ResourceLedger {
    /// Every row the host has sent for each thread, removed ones included (the sheet filters).
    public private(set) var bySession: [String: [ThreadResource]] = [:]
    /// Rows a removal is in flight for from this device, until the push answers.
    public private(set) var removing: Set<String> = []

    public init() {}

    /// The thread's live (unremoved) rows.
    public func live(for sessionId: String) -> [ThreadResource] {
        (bySession[sessionId] ?? []).filter { $0.removedAt == nil }
    }

    /// How many live resources the given threads hold: the fleet's "and remove their N worktrees and simulators".
    public func countHeld(by sessionIds: [String]) -> Int {
        sessionIds.reduce(0) { $0 + live(for: $1).count }
    }

    /// The host's push: that thread's whole ledger. A row the push says is
    /// removed, or still live, is no longer being removed from here.
    public func apply(_ push: ResourcesPush) {
        bySession[push.sessionId] = push.resources
        for row in push.resources { removing.remove(row.id) }
    }

    /// Every live row the host holds, once per socket open. This host's
    /// threads start over from the answer; removed rows the sheet already
    /// held stay. An older host without the method keeps what it had.
    public func loadAll(_ client: EnvironmentClient) async {
        guard let answer = try? await client.request(Methods.ResourcesListAll.self, .init()) else { return }
        var byThread: [String: [ThreadResource]] = [:]
        for row in answer.resources { byThread[row.sessionId, default: []].append(row) }
        var next: [String: [ThreadResource]] = [:]
        for (sessionId, rows) in bySession { next[sessionId] = rows.filter { $0.removedAt != nil } }
        for (sessionId, rows) in byThread { next[sessionId] = rows + (next[sessionId] ?? []) }
        bySession = next
    }

    /// One thread's rows, removed ones included; the sheet calls it on appear.
    public func load(_ client: EnvironmentClient, sessionId: String) async {
        guard let answer = try? await client.request(Methods.ResourcesList.self, .init(sessionId: sessionId, includeRemoved: true)) else { return }
        bySession[sessionId] = answer.resources
    }

    func markRemoving(_ ids: [String]) {
        removing.formUnion(ids)
    }

    func unmarkRemoving(_ ids: [String]) {
        removing.subtract(ids)
    }
}

extension EnvironmentClient {
    /// Remove the named rows (nil: every live row) on their hosts; the push
    /// brings the outcome. The rows read as removing meanwhile.
    public func removeResources(_ sessionId: String, ids: [String]? = nil) async throws -> [ThreadResourceRemoval] {
        if let block = operateBlock { throw ActionError.blocked(block) }
        let marked = ids ?? resources.live(for: sessionId).map(\.id)
        resources.markRemoving(marked)
        do {
            let answer = try await request(Methods.ResourcesRemove.self, .init(sessionId: sessionId, ids: ids))
            return answer.results
        } catch {
            resources.unmarkRemoving(marked)
            throw ActionError.wrap(error)
        }
    }

    /// Archive, removing the thread's live resources with it when asked: the
    /// one archive call every flow uses.
    public func archive(_ sessionId: String, removeResources: Bool) async throws {
        if let block = operateBlock { throw ActionError.blocked(block) }
        do {
            try await request(Methods.SessionArchive.self, .init(sessionId: sessionId, archived: true, removeResources: removeResources ? true : nil))
        } catch {
            throw ActionError.wrap(error)
        }
    }
}

/// The words of the Resources sheet and the archive prompt (threadResources.ts).
public enum ResourceWords {
    public static func kindLabel(_ kind: ThreadResourceKind) -> String {
        switch kind {
        case .worktree: "worktree"
        case .simulator: "simulator"
        case .devInstance: "dev instance"
        case .port: "dev server"
        case .unknown(let value): value
        }
    }

    public static func symbol(_ kind: ThreadResourceKind) -> String {
        switch kind {
        case .worktree: "arrow.triangle.pull"
        case .simulator: "iphone"
        case .devInstance: "macwindow"
        case .port: "network"
        case .unknown: "shippingbox"
        }
    }

    /// The clause after "Archive": "and remove 2 resources on the Mac", "and
    /// remove 3 resources on the Mac and the box"; "" for no rows.
    public static func removalClause(_ rows: [ThreadResource], hostName: (String) -> String) -> String {
        let n = rows.count
        guard n > 0 else { return "" }
        var seen: Set<String> = []
        let hosts = rows.compactMap { seen.insert($0.environmentId).inserted ? hostName($0.environmentId) : nil }
        let whereClause = hosts.count == 1 ? hosts[0] : "\(hosts.dropLast().joined(separator: ", ")) and \(hosts[hosts.count - 1])"
        return "and remove \(n) resource\(n == 1 ? "" : "s") on \(whereClause)"
    }

    /// One row's state word, when it has one: the note or "removed" once
    /// removed, the note or "removing…" while requested, else the note.
    public static func rowState(_ row: ThreadResource) -> String? {
        if row.removedAt != nil { return row.note ?? "removed" }
        if row.removeRequestedAt != nil { return row.note ?? "removing…" }
        return row.note
    }

    /// A row waits for an offline host: requested and not removed.
    public static func isWaiting(_ row: ThreadResource) -> Bool {
        row.removeRequestedAt != nil && row.removedAt == nil
    }

    /// The host a row lives on, by name: this client's host by its paired
    /// name, another paired host by its name, else "the Mac" (a bridged
    /// resource lives on the Mac the box reaches).
    public static func hostName(_ environmentId: String, here: PairedEnvironment, paired: [PairedEnvironment]) -> String {
        if environmentId == here.id { return here.name }
        if let other = paired.first(where: { $0.id == environmentId }) { return other.name }
        return "the Mac"
    }

    /// The host's name as a section's heading: "The Mac" for an unknown one.
    public static func hostHeading(_ environmentId: String, here: PairedEnvironment, paired: [PairedEnvironment]) -> String {
        let name = hostName(environmentId, here: here, paired: paired)
        return name.prefix(1).uppercased() + name.dropFirst()
    }
}
