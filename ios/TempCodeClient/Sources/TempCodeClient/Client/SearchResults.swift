import TempCodeContract

/// The same imported id can exist on several hosts.
public struct EnvironmentResourceID: Sendable, Hashable {
    public let environmentId: String
    public let resourceId: String

    public init(environmentId: String, resourceId: String) {
        self.environmentId = environmentId
        self.resourceId = resourceId
    }
}

public struct ThreadHits: Sendable, Identifiable {
    public let environmentId: String
    public let sessionId: String
    public let title: String
    public let type: ThreadType?
    public var hits: [SessionSearchHit]

    public var id: EnvironmentResourceID { EnvironmentResourceID(environmentId: environmentId, resourceId: sessionId) }

    /// One host's answer, grouped in the order the host ranked the hits.
    public static func group(environmentId: String, hits: [SessionSearchHit], sessions: [SessionMeta]) -> [ThreadHits] {
        var groups: [ThreadHits] = []
        var index: [EnvironmentResourceID: Int] = [:]
        for hit in hits {
            let key = EnvironmentResourceID(environmentId: environmentId, resourceId: hit.sessionId)
            if let at = index[key] {
                groups[at].hits.append(hit)
            } else {
                let session = sessions.first { $0.id == hit.sessionId }
                index[key] = groups.count
                groups.append(ThreadHits(environmentId: environmentId, sessionId: hit.sessionId, title: session?.title ?? "Thread", type: session?.threadType, hits: [hit]))
            }
        }
        return groups
    }
}
