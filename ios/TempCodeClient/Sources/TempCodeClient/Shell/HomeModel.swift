import Foundation
import TempCodeContract

/// A thread that needs the user: an undecided approval or an unanswered
/// question (`waiting`), a failed root, or a paused one.
public struct NeedsYouItem: Sendable, Hashable, Identifiable {
    public enum Kind: Sendable, Hashable {
        case waiting
        case error
        case paused
    }

    public var meta: SessionMeta
    public var kind: Kind
    /// When the thread started needing the user (ms).
    public var since: Int

    public init(meta: SessionMeta, kind: Kind, since: Int) {
        self.meta = meta
        self.kind = kind
        self.since = since
    }

    public var id: String { meta.id }
}

/// What Home derives from one host's sessions: the needs-you rows and the
/// running rows. Both are absent when empty.
public enum HomeModel {
    /// Any thread that waits (a subagent's approval needs the user as much as
    /// a root's), and roots that failed or paused. Longest waiting first.
    public static func needsYou(_ metas: [SessionMeta]) -> [NeedsYouItem] {
        metas.compactMap { meta -> NeedsYouItem? in
            guard !meta.archived else { return nil }
            switch meta.status {
            case .waiting:
                return NeedsYouItem(meta: meta, kind: .waiting, since: meta.updatedAt)
            case .error where meta.parentId == nil:
                return NeedsYouItem(meta: meta, kind: .error, since: meta.updatedAt)
            case .paused where meta.parentId == nil:
                return NeedsYouItem(meta: meta, kind: .paused, since: meta.pausedAt ?? meta.updatedAt)
            default:
                return nil
            }
        }
        .sorted { ($0.since, $0.meta.id) < ($1.since, $1.meta.id) }
    }

    /// Live roots: running or starting, or settled with a subagent still at
    /// work. Most recently moved first. Subagents fold under their root.
    public static func running(_ metas: [SessionMeta]) -> [SessionMeta] {
        metas
            .filter { $0.parentId == nil && !$0.archived && ($0.status == .running || $0.status == .starting || $0.treeHasLiveWork == true) }
            .sorted { ($0.updatedAt, $0.id) > ($1.updatedAt, $1.id) }
    }

    /// The one line a needs-you row says, from the thread's newest rows: the
    /// undecided approval ("Approve: run bun test"), the unanswered question
    /// ("Question: which email?"), or the error. Without rows, the kind alone.
    public static func line(for kind: NeedsYouItem.Kind, rows: [EventRow]) -> String {
        switch kind {
        case .paused:
            return "Paused"
        case .error:
            for row in rows.reversed() {
                if case .error(let error) = row.event {
                    if error.stopped == true { return "Stopped" }
                    return "Error: \(firstLine(error.message))"
                }
            }
            return "Failed"
        case .waiting:
            var resolved: Set<String> = []
            for row in rows.reversed() {
                switch row.event {
                case .approvalResolved(let done):
                    resolved.insert(done.requestId)
                case .questionResolved(let done):
                    resolved.insert(done.requestId)
                case .approvalRequest(let request) where !resolved.contains(request.requestId):
                    return "Approve: \(firstLine(request.title ?? request.toolName))"
                case .questionRequest(let request) where !resolved.contains(request.requestId):
                    if let question = request.questions.first?.question { return "Question: \(firstLine(question))" }
                    return "Question"
                default:
                    continue
                }
            }
            return "Waiting for you"
        }
    }

    static func firstLine(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).first.map { String($0).trimmingCharacters(in: .whitespaces) } ?? ""
    }
}
