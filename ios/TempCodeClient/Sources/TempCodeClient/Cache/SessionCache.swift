import Foundation
import TempCodeContract

/// What a cold launch paints for one environment before its socket is up.
public struct CachedShell: Sendable, Hashable {
    public var workspaces: [WorkspaceMeta]
    public var projects: [ProjectMeta]
    public var sessions: [SessionMeta]

    public init(workspaces: [WorkspaceMeta] = [], projects: [ProjectMeta] = [], sessions: [SessionMeta] = []) {
        self.workspaces = workspaces
        self.projects = projects
        self.sessions = sessions
    }

    public static let empty = CachedShell()
}

/// The newest rows of one thread as the cache has them, oldest first.
public struct CachedTail: Sendable, Hashable {
    public var rows: [EventRow]
    /// The host said older rows exist, or the cache holds more than this page.
    public var moreBefore: Bool
    /// The highest seq held; a resume asks the host for what follows it.
    public var cursor: Int

    public init(rows: [EventRow], moreBefore: Bool, cursor: Int) {
        self.rows = rows
        self.moreBefore = moreBefore
        self.cursor = cursor
    }
}

/// Rows a thread keeps on disk at most; the oldest go first. Rows, not
/// turns: an agent thread packs tens of thousands of rows into a few turns.
public let cacheRowsPerThread = 1_000
/// Prune only past this, so a busy thread does not pay a delete per page.
let cachePruneAt = 1_300

/// The on-disk mirror of what the socket has shown, keyed by environment:
/// the shell (workspaces, projects, sessions), the newest rows of each
/// thread, and the whole rows `session.rowBody` fetched for omitted bodies.
/// Everything is stored as the wire's JSON, which the contract re-encodes
/// byte for byte, so an older build can hold what a newer host sent.
/// Rows key on (environment, session, seq): writing a row the cache already
/// has replaces it, so a resume can never duplicate one.
public actor SessionCache {
    private let db: Database

    public init(path: URL) throws(CacheError) {
        try? FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
        db = try Database(path: path.path(percentEncoded: false))
        try SessionCache.migrate(db)
    }

    /// A cache that lives only as long as the process: tests and previews.
    public static func inMemory() throws(CacheError) -> SessionCache {
        try SessionCache(path: URL(filePath: ":memory:"))
    }

    public static func defaultPath() -> URL {
        EnvironmentStore.defaultDirectory().appending(path: "cache.sqlite")
    }

    private static func migrate(_ db: Database) throws(CacheError) {
        try db.exec("PRAGMA journal_mode = WAL")
        try db.exec("PRAGMA synchronous = NORMAL")
        try db.exec("""
        CREATE TABLE IF NOT EXISTS workspaces (env TEXT NOT NULL, id TEXT NOT NULL, json BLOB NOT NULL, PRIMARY KEY (env, id));
        CREATE TABLE IF NOT EXISTS projects (env TEXT NOT NULL, id TEXT NOT NULL, json BLOB NOT NULL, PRIMARY KEY (env, id));
        CREATE TABLE IF NOT EXISTS sessions (env TEXT NOT NULL, id TEXT NOT NULL, updated_at INTEGER NOT NULL, json BLOB NOT NULL, PRIMARY KEY (env, id));
        CREATE TABLE IF NOT EXISTS session_state (env TEXT NOT NULL, session_id TEXT NOT NULL, more_before INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (env, session_id));
        CREATE TABLE IF NOT EXISTS rows (env TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, json BLOB NOT NULL, PRIMARY KEY (env, session_id, seq));
        CREATE TABLE IF NOT EXISTS bodies (env TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, json BLOB NOT NULL, PRIMARY KEY (env, session_id, seq));
        """)
    }

    // MARK: - shell

    public func replaceWorkspaces(_ env: String, _ workspaces: [WorkspaceMeta]) throws(CacheError) {
        try db.transaction { () throws(CacheError) in
            try db.run("DELETE FROM workspaces WHERE env = ?", [.text(env)])
            for workspace in workspaces {
                try db.run("INSERT INTO workspaces (env, id, json) VALUES (?, ?, ?)", [.text(env), .text(workspace.id), .blob(try encode(workspace))])
            }
        }
    }

    public func replaceProjects(_ env: String, _ projects: [ProjectMeta]) throws(CacheError) {
        try db.transaction { () throws(CacheError) in
            try db.run("DELETE FROM projects WHERE env = ?", [.text(env)])
            for project in projects {
                try db.run("INSERT INTO projects (env, id, json) VALUES (?, ?, ?)", [.text(env), .text(project.id), .blob(try encode(project))])
            }
        }
    }

    /// Newest meta per session wins; sessions not named are kept.
    public func upsertSessions(_ env: String, _ sessions: [SessionMeta]) throws(CacheError) {
        try db.transaction { () throws(CacheError) in
            for session in sessions {
                try db.run("INSERT OR REPLACE INTO sessions (env, id, updated_at, json) VALUES (?, ?, ?, ?)", [.text(env), .text(session.id), .int(session.updatedAt), .blob(try encode(session))])
            }
        }
    }

    public func removeSessions(_ env: String, _ ids: [String]) throws(CacheError) {
        try db.transaction { () throws(CacheError) in
            for id in ids {
                try db.run("DELETE FROM sessions WHERE env = ? AND id = ?", [.text(env), .text(id)])
                try db.run("DELETE FROM rows WHERE env = ? AND session_id = ?", [.text(env), .text(id)])
                try db.run("DELETE FROM bodies WHERE env = ? AND session_id = ?", [.text(env), .text(id)])
                try db.run("DELETE FROM session_state WHERE env = ? AND session_id = ?", [.text(env), .text(id)])
            }
        }
    }

    public func shell(_ env: String) throws(CacheError) -> CachedShell {
        var shell = CachedShell()
        try db.query("SELECT json FROM workspaces WHERE env = ? ORDER BY rowid", [.text(env)]) { (row) throws(CacheError) in
            if let value: WorkspaceMeta = try? decode(row.blob(0)) { shell.workspaces.append(value) }
        }
        try db.query("SELECT json FROM projects WHERE env = ? ORDER BY rowid", [.text(env)]) { (row) throws(CacheError) in
            if let value: ProjectMeta = try? decode(row.blob(0)) { shell.projects.append(value) }
        }
        try db.query("SELECT json FROM sessions WHERE env = ? ORDER BY updated_at DESC", [.text(env)]) { (row) throws(CacheError) in
            if let value: SessionMeta = try? decode(row.blob(0)) { shell.sessions.append(value) }
        }
        return shell
    }

    // MARK: - rows

    /// Stores a page or a push. `reset` is D2's rule: the host sent a fresh
    /// tail because the gap outgrew the replay budget, so the rows held so
    /// far go first. Ephemeral rows are never kept.
    public func store(_ env: String, sessionId: String, rows: [EventRow], moreBefore: Bool? = nil, reset: Bool = false) throws(CacheError) {
        try db.transaction { () throws(CacheError) in
            if reset {
                try db.run("DELETE FROM rows WHERE env = ? AND session_id = ?", [.text(env), .text(sessionId)])
            }
            for row in rows where row.ephemeral != true {
                try db.run("INSERT OR REPLACE INTO rows (env, session_id, seq, ts, json) VALUES (?, ?, ?, ?, ?)", [.text(env), .text(sessionId), .int(row.seq), .int(row.ts), .blob(try encode(row))])
            }
            if let moreBefore {
                try db.run("INSERT OR REPLACE INTO session_state (env, session_id, more_before) VALUES (?, ?, ?)", [.text(env), .text(sessionId), .int(moreBefore ? 1 : 0)])
            }
            let count = try db.scalar("SELECT COUNT(*) FROM rows WHERE env = ? AND session_id = ?", [.text(env), .text(sessionId)]) ?? 0
            if count > cachePruneAt {
                try prune(env, sessionId: sessionId, keep: cacheRowsPerThread)
            }
        }
    }

    /// The newest `limit` rows, oldest first.
    public func tail(_ env: String, sessionId: String, limit: Int = 300) throws(CacheError) -> CachedTail {
        var rows: [EventRow] = []
        try db.query("SELECT json FROM rows WHERE env = ? AND session_id = ? ORDER BY seq DESC LIMIT ?", [.text(env), .text(sessionId), .int(limit)]) { (row) throws(CacheError) in
            if let value: EventRow = try? decode(row.blob(0)) { rows.append(value) }
        }
        rows.reverse()
        let held = try db.scalar("SELECT COUNT(*) FROM rows WHERE env = ? AND session_id = ?", [.text(env), .text(sessionId)]) ?? 0
        let hostHasMore = (try db.scalar("SELECT more_before FROM session_state WHERE env = ? AND session_id = ?", [.text(env), .text(sessionId)]) ?? 0) == 1
        let cursor = try db.scalar("SELECT MAX(seq) FROM rows WHERE env = ? AND session_id = ?", [.text(env), .text(sessionId)]) ?? 0
        return CachedTail(rows: rows, moreBefore: hostHasMore || held > rows.count, cursor: cursor)
    }

    /// Up to `limit` rows older than `seq`, oldest first.
    public func rows(_ env: String, sessionId: String, before seq: Int, limit: Int = 300) throws(CacheError) -> [EventRow] {
        var rows: [EventRow] = []
        try db.query("SELECT json FROM rows WHERE env = ? AND session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?", [.text(env), .text(sessionId), .int(seq), .int(limit)]) { (row) throws(CacheError) in
            if let value: EventRow = try? decode(row.blob(0)) { rows.append(value) }
        }
        return rows.reversed()
    }

    /// The highest seq held for the thread; 0 when none.
    public func cursor(_ env: String, sessionId: String) throws(CacheError) -> Int {
        try db.scalar("SELECT MAX(seq) FROM rows WHERE env = ? AND session_id = ?", [.text(env), .text(sessionId)]) ?? 0
    }

    /// The lowest seq held; nil when none.
    public func oldestSeq(_ env: String, sessionId: String) throws(CacheError) -> Int? {
        try db.scalar("SELECT MIN(seq) FROM rows WHERE env = ? AND session_id = ?", [.text(env), .text(sessionId)])
    }

    public func moreBefore(_ env: String, sessionId: String) throws(CacheError) -> Bool {
        (try db.scalar("SELECT more_before FROM session_state WHERE env = ? AND session_id = ?", [.text(env), .text(sessionId)]) ?? 1) == 1
    }

    /// Drops everything but the newest `keep` rows of the thread.
    public func prune(_ env: String, sessionId: String, keep: Int = cacheRowsPerThread) throws(CacheError) {
        try db.run("""
        DELETE FROM rows WHERE env = ? AND session_id = ? AND seq < (
            SELECT MIN(seq) FROM (SELECT seq FROM rows WHERE env = ? AND session_id = ? ORDER BY seq DESC LIMIT ?)
        )
        """, [.text(env), .text(sessionId), .text(env), .text(sessionId), .int(keep)])
        try db.run("INSERT OR REPLACE INTO session_state (env, session_id, more_before) VALUES (?, ?, 1)", [.text(env), .text(sessionId)])
    }

    // MARK: - bodies

    /// The whole row `session.rowBody` answered, kept for good: persisted rows never change.
    public func storeBody(_ env: String, sessionId: String, seq: Int, row: EventRow) throws(CacheError) {
        try db.run("INSERT OR REPLACE INTO bodies (env, session_id, seq, json) VALUES (?, ?, ?, ?)", [.text(env), .text(sessionId), .int(seq), .blob(try encode(row))])
    }

    public func body(_ env: String, sessionId: String, seq: Int) throws(CacheError) -> EventRow? {
        var out: EventRow?
        try db.query("SELECT json FROM bodies WHERE env = ? AND session_id = ? AND seq = ?", [.text(env), .text(sessionId), .int(seq)]) { (row) throws(CacheError) in
            out = try? decode(row.blob(0))
        }
        return out
    }

    // MARK: - removal

    /// The environment was removed: forget everything of it.
    public func clear(_ env: String) throws(CacheError) {
        try db.transaction { () throws(CacheError) in
            for table in ["workspaces", "projects", "sessions", "session_state", "rows", "bodies"] {
                try db.run("DELETE FROM \(table) WHERE env = ?", [.text(env)])
            }
        }
    }

    // MARK: - json

    private func encode(_ value: some Encodable) throws(CacheError) -> Data {
        do {
            return try JSONEncoder().encode(value)
        } catch {
            throw CacheError.encoding(String(describing: error))
        }
    }

    private func decode<T: Decodable>(_ data: Data) throws(CacheError) -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw CacheError.encoding(String(describing: error))
        }
    }
}
