import Foundation

/// One source on the research board; a url cited twice is two rows.
public struct SourceRow: Sendable, Hashable, Identifiable {
    public var callId: String
    public var url: String
    public var title: String?
    /// The one-line finding this source supports (cite_source).
    public var claim: String?

    public init(callId: String, url: String, title: String? = nil, claim: String? = nil) {
        self.callId = callId
        self.url = url
        self.title = title
        self.claim = claim
    }

    public var id: String { callId }
}

public struct QueryGroup: Sendable, Hashable {
    /// nil = sources fetched before any query (direct fetches).
    public var query: String?
    public var sources: [SourceRow]

    public init(query: String?, sources: [SourceRow]) {
        self.query = query
        self.sources = sources
    }
}

/// One research angle (an agent): its queries in order with the sources
/// they surfaced beneath.
public struct ResearchAngle: Sendable, Hashable, Identifiable {
    public var agentId: String
    public var label: String
    public var queries: [QueryGroup]

    public init(agentId: String, label: String, queries: [QueryGroup]) {
        self.agentId = agentId
        self.label = label
        self.queries = queries
    }

    public var id: String { agentId }
    public var sourceCount: Int { queries.reduce(0) { $0 + $1.sources.count } }
}

/// The research board's data: research-source rows folded into one group
/// per angle. Totals count unique URLs and queries across the thread; a
/// source two angles consulted shows in both groups but counts once.
public struct ResearchBoard: Sendable, Hashable {
    public var angles: [ResearchAngle]
    public var sources: Int
    public var searches: Int

    public static let empty = ResearchBoard(angles: [], sources: 0, searches: 0)

    public static func fold(_ rows: [ResearchSource]) -> ResearchBoard {
        if rows.isEmpty { return .empty }
        var angles: [ResearchAngle] = []
        var angleIndex: [String: Int] = [:]
        var byCall: [String: (angle: Int, query: Int, source: Int)] = [:]
        var urls: Set<String> = []
        var queries: Set<String> = []
        for row in rows {
            if let known = byCall[row.callId] {
                if let title = row.title { angles[known.angle].queries[known.query].sources[known.source].title = title }
                if let claim = row.claim { angles[known.angle].queries[known.query].sources[known.source].claim = claim }
                continue
            }
            let a: Int
            if let index = angleIndex[row.agentId] {
                a = index
            } else {
                a = angles.count
                angleIndex[row.agentId] = a
                angles.append(ResearchAngle(agentId: row.agentId, label: row.agentLabel, queries: []))
            }
            if let query = row.query {
                queries.insert(query)
                angles[a].queries.append(QueryGroup(query: query, sources: []))
            } else if let url = row.url {
                urls.insert(url)
                if angles[a].queries.isEmpty { angles[a].queries.append(QueryGroup(query: nil, sources: [])) }
                let q = angles[a].queries.count - 1
                angles[a].queries[q].sources.append(SourceRow(callId: row.callId, url: url, title: row.title, claim: row.claim))
                byCall[row.callId] = (a, q, angles[a].queries[q].sources.count - 1)
            }
        }
        return ResearchBoard(angles: angles, sources: urls.count, searches: queries.count)
    }

    /// The angles the board shows: every child the thread spawned, in spawn
    /// order, whether or not it has boarded a source yet, plus any other
    /// agent that boarded sources (the root's own research) ahead of them.
    public static func mergeAngles(_ board: ResearchBoard, agents: [String]) -> [ResearchAngle] {
        if agents.isEmpty { return board.angles }
        let byAgent = Dictionary(board.angles.map { ($0.agentId, $0) }, uniquingKeysWith: { first, _ in first })
        let spawned = Set(agents)
        return board.angles.filter { !spawned.contains($0.agentId) } + agents.map { byAgent[$0] ?? ResearchAngle(agentId: $0, label: "", queries: []) }
    }

    /// The host of a url without its www, or "" for anything that is not one.
    public static func host(of url: String) -> String {
        guard let parsed = URL(string: url), let host = parsed.host(percentEncoded: false), !host.isEmpty else { return "" }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}
