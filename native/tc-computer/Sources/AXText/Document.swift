import ComputerProtocol
import Foundation

private typealias T = ObservationTables

/// What is behind the window on disk, as its document line says it (docs/computer-protocol.md
/// §25.10): the window's AXDocument and the close button's AXEdited (E5), read in the walk's stage B.
public struct WindowDocument: Sendable, Equatable {
    public enum Kind: Sendable, Equatable { case file, folder, unsaved }

    public var kind: Kind
    /// `~`-relative under the home folder; nil for `unsaved`
    public var path: String?
    /// the file's mtime as a local clock time, `14:02:11`
    public var written: String?
    public var edited: Bool

    public init(kind: Kind, path: String? = nil, written: String? = nil, edited: Bool = false) {
        self.kind = kind
        self.path = path
        self.written = written
        self.edited = edited
    }

    /// From what the walk read: AXDocument's URL (a `file:` URL; a folder's ends in /), the file's
    /// mtime (seconds since 1970), the edited flag. A window with no document says something only
    /// while it is edited; a URL of another scheme says nothing.
    public static func from(url: String?, mtime: Double?, edited: Bool, home: String, timeZone: TimeZone) -> WindowDocument? {
        guard let url else { return edited ? WindowDocument(kind: .unsaved, edited: true) : nil }
        guard let path = filePath(url) else { return nil }
        let folder = url.hasSuffix("/")
        let shown = tilde(folder && path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path, home: home)
        if folder { return WindowDocument(kind: .folder, path: shown) }
        return WindowDocument(kind: .file, path: shown, written: mtime.map { clock($0, timeZone: timeZone) }, edited: edited)
    }

    /// The line, as src/shared/computer/observation.ts formatDocumentLine writes it; `changed` is a
    /// diff's `~ ` form. The edited flag never rides a folder.
    public func line(changed: Bool = false) -> String {
        var s = changed ? "~ " : ""
        switch kind {
        case .unsaved:
            s += T.documentUnsaved
        case .folder:
            s += T.documentFolder + Quote.json(path ?? "")
        case .file:
            s += T.documentFile + Quote.json(path ?? "")
            if let written { s += T.documentWritten + written }
        }
        if edited, kind != .folder { s += T.headerSeparator + T.documentEdited }
        return s
    }

    /// `HH:MM:SS` in the time zone, 24-hour.
    public static func clock(_ seconds: Double, timeZone: TimeZone) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let c = cal.dateComponents([.hour, .minute, .second], from: Date(timeIntervalSince1970: seconds))
        return String(format: "%02d:%02d:%02d", c.hour ?? 0, c.minute ?? 0, c.second ?? 0)
    }

    /// The path of a `file:` URL, percent-decoded; nil for another scheme.
    static func filePath(_ url: String) -> String? {
        let lower = url.lowercased()
        let rest: Substring
        if lower.hasPrefix("file://localhost/") {
            rest = url.dropFirst("file://localhost".count)
        } else if lower.hasPrefix("file:///") {
            rest = url.dropFirst("file://".count)
        } else {
            return nil
        }
        return String(rest).removingPercentEncoding
    }

    static func tilde(_ path: String, home: String) -> String {
        let home = home.count > 1 && home.hasSuffix("/") ? String(home.dropLast()) : home
        if path == home { return "~" }
        if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
        return path
    }
}
