import Foundation
import SQLite3

public enum CacheError: Error, Hashable, Sendable {
    case sqlite(code: Int32, message: String)
    case encoding(String)
}

/// The few SQLite calls the cache needs, over the system library: open,
/// exec, prepared statements with text / integer / blob binds, and row
/// reads. Not thread-safe on its own; `SessionCache` owns one instance.
/// Raw sqlite3 rather than GRDB: no dependency to resolve in the gate, the
/// schema is six tables of JSON blobs with primary keys, and the whole
/// wrapper is shorter than GRDB's record protocols would be.
final class Database {
    private var handle: OpaquePointer?
    private var statements: [String: OpaquePointer] = [:]
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(path: String) throws(CacheError) {
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let code = sqlite3_open_v2(path, &handle, flags, nil)
        guard code == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "could not open"
            sqlite3_close(handle)
            throw CacheError.sqlite(code: code, message: message)
        }
        self.handle = handle
        sqlite3_busy_timeout(handle, 2_000)
    }

    deinit {
        for statement in statements.values { sqlite3_finalize(statement) }
        sqlite3_close_v2(handle)
    }

    func exec(_ sql: String) throws(CacheError) {
        var error: UnsafeMutablePointer<CChar>?
        let code = sqlite3_exec(handle, sql, nil, nil, &error)
        guard code == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? "exec failed"
            sqlite3_free(error)
            throw CacheError.sqlite(code: code, message: message)
        }
    }

    func transaction<T>(_ body: () throws(CacheError) -> T) throws(CacheError) -> T {
        try exec("BEGIN IMMEDIATE")
        do {
            let value = try body()
            try exec("COMMIT")
            return value
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
    }

    enum Value {
        case text(String)
        case int(Int)
        case blob(Data)
        case null
    }

    struct Row {
        fileprivate let statement: OpaquePointer

        func text(_ index: Int32) -> String {
            guard let pointer = sqlite3_column_text(statement, index) else { return "" }
            return String(cString: pointer)
        }

        func int(_ index: Int32) -> Int {
            Int(sqlite3_column_int64(statement, index))
        }

        func blob(_ index: Int32) -> Data {
            let count = Int(sqlite3_column_bytes(statement, index))
            guard count > 0, let pointer = sqlite3_column_blob(statement, index) else { return Data() }
            return Data(bytes: pointer, count: count)
        }

        func isNull(_ index: Int32) -> Bool {
            sqlite3_column_type(statement, index) == SQLITE_NULL
        }
    }

    /// Runs `sql` with `binds`, calling `read` once per row.
    func query(_ sql: String, _ binds: [Value] = [], read: (Row) throws(CacheError) -> Void = { _ in }) throws(CacheError) {
        let statement = try prepared(sql)
        defer {
            sqlite3_reset(statement)
            sqlite3_clear_bindings(statement)
        }
        try bind(binds, to: statement)
        while true {
            let code = sqlite3_step(statement)
            if code == SQLITE_ROW {
                try read(Row(statement: statement))
                continue
            }
            if code == SQLITE_DONE { return }
            throw CacheError.sqlite(code: code, message: String(cString: sqlite3_errmsg(handle)))
        }
    }

    func run(_ sql: String, _ binds: [Value] = []) throws(CacheError) {
        try query(sql, binds)
    }

    /// The first column of the first row as an integer, or nil.
    func scalar(_ sql: String, _ binds: [Value] = []) throws(CacheError) -> Int? {
        var out: Int?
        try query(sql, binds) { (row) throws(CacheError) in
            if out == nil, !row.isNull(0) { out = row.int(0) }
        }
        return out
    }

    private func prepared(_ sql: String) throws(CacheError) -> OpaquePointer {
        if let statement = statements[sql] { return statement }
        var statement: OpaquePointer?
        let code = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
        guard code == SQLITE_OK, let statement else {
            throw CacheError.sqlite(code: code, message: String(cString: sqlite3_errmsg(handle)))
        }
        statements[sql] = statement
        return statement
    }

    private func bind(_ binds: [Value], to statement: OpaquePointer) throws(CacheError) {
        for (offset, value) in binds.enumerated() {
            let index = Int32(offset + 1)
            let code: Int32
            switch value {
            case .text(let text): code = sqlite3_bind_text(statement, index, text, -1, Database.transient)
            case .int(let int): code = sqlite3_bind_int64(statement, index, Int64(int))
            case .blob(let data):
                code = data.withUnsafeBytes { bytes in
                    sqlite3_bind_blob(statement, index, bytes.baseAddress, Int32(data.count), Database.transient)
                }
            case .null: code = sqlite3_bind_null(statement, index)
            }
            guard code == SQLITE_OK else {
                throw CacheError.sqlite(code: code, message: String(cString: sqlite3_errmsg(handle)))
            }
        }
    }
}
