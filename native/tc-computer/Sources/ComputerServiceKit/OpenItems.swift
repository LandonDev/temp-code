import ComputerProtocol
import Foundation

/// What the live side reads of a path on the Mac before `apps.launch` opens it (docs/computer-protocol.md §22.2).
public struct FileFacts: Equatable, Sendable {
    public var exists: Bool
    public var isDirectory: Bool
    /// a package or bundle (`.app`, `.bundle`, `.rtfd`), as Finder shows one
    public var isBundle: Bool
    /// the bundle names an executable (`Bundle.executableURL`)
    public var hasExecutable: Bool
    /// a plain file with an execute bit for anyone
    public var executeBit: Bool
    /// its type conforms to `public.executable`, `public.script` or `com.apple.application`
    public var conformsToExecutable: Bool

    public init(exists: Bool, isDirectory: Bool = false, isBundle: Bool = false, hasExecutable: Bool = false, executeBit: Bool = false, conformsToExecutable: Bool = false) {
        self.exists = exists
        self.isDirectory = isDirectory
        self.isBundle = isBundle
        self.hasExecutable = hasExecutable
        self.executeBit = executeBit
        self.conformsToExecutable = conformsToExecutable
    }

    /// Nothing at the path.
    public static let missing = FileFacts(exists: false)
}

/// Why an item, or a call's items, will not open; the service answers it as `open_refused`.
public struct OpenRefusal: Error, Equatable, Sendable {
    /// `missing`, `executable` or `scheme`; nil for too many items
    public var reason: ErrorReason?
    public var item: String
    public var message: String

    public init(reason: ErrorReason?, item: String, message: String) {
        self.reason = reason
        self.item = item
        self.message = message
    }

    public var error: ComputerError {
        ComputerError(kind: .openRefused, message: message, reason: reason)
    }
}

/// One item `apps.launch` opens into the named app: a web page or a file or folder on the Mac. Never a
/// program: opening a `.command` in Terminal runs it, so no app is an exception.
public struct OpenItem: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// an `http:` or `https:` URL, as given
        case web(String)
        /// an absolute path, from a path or a `file:` URL
        case file(String)
    }

    public var raw: String
    public var kind: Kind

    public init(raw: String, kind: Kind) {
        self.raw = raw
        self.kind = kind
    }

    /// The path NSWorkspace opens, or the URL's text.
    public var target: String {
        switch kind {
        case .web(let url): url
        case .file(let path): path
        }
    }

    /// The name a message gives the item: a file's last component, a URL as written.
    public var label: String {
        switch kind {
        case .web(let url): url
        case .file(let path): (path as NSString).lastPathComponent.isEmpty ? path : (path as NSString).lastPathComponent
        }
    }

    /// `http:` or `https:` URLs, `file:` URLs and absolute paths; a file must exist and be no program.
    /// Folders are fine. `facts` reads the path on the Mac; nil is read as missing.
    public static func classify(_ raw: String, facts: (String) -> FileFacts?) -> Result<OpenItem, OpenRefusal> {
        let path: String
        if raw.hasPrefix("/") {
            path = raw
        } else {
            switch scheme(of: raw) {
            case "http", "https":
                guard let url = URL(string: raw), let host = url.host, !host.isEmpty else {
                    return .failure(OpenRefusal(reason: .scheme, item: raw, message: "\(raw) is not a web address that opens."))
                }
                return .success(OpenItem(raw: raw, kind: .web(raw)))
            case "file":
                guard let url = URL(string: raw), url.host == nil || url.host == "" || url.host == "localhost", url.path.hasPrefix("/") else {
                    return .failure(OpenRefusal(reason: .scheme, item: raw, message: "\(raw) names no file on this Mac."))
                }
                path = url.path
            default:
                return .failure(OpenRefusal(reason: .scheme, item: raw, message: "Only http, https and file items open, and a path must be absolute; \(raw) is neither."))
            }
        }
        let name = (path as NSString).lastPathComponent
        guard let read = facts(path), read.exists else {
            return .failure(OpenRefusal(reason: .missing, item: raw, message: "No file at \(path) on the Mac."))
        }
        let program = read.isBundle ? read.hasExecutable : (!read.isDirectory && read.executeBit)
        if program || read.conformsToExecutable {
            return .failure(OpenRefusal(reason: .executable, item: raw, message: "\(name) is a program; open only opens documents, folders and web pages."))
        }
        return .success(OpenItem(raw: raw, kind: .file(path)))
    }

    /// Every item of one call, at most `SERVICE.openItemsMax`; the first refusal wins, so nothing opens.
    public static func classifyAll(_ raws: [String], facts: (String) -> FileFacts?) -> Result<[OpenItem], OpenRefusal> {
        let most = ComputerDefaults.Service.openItemsMax
        guard raws.count <= most else {
            return .failure(OpenRefusal(reason: nil, item: "", message: "At most \(most) items open in one call; this one named \(raws.count)."))
        }
        var items: [OpenItem] = []
        for raw in raws {
            switch classify(raw, facts: facts) {
            case .success(let item): items.append(item)
            case .failure(let refusal): return .failure(refusal)
            }
        }
        return .success(items)
    }

    /// The scheme before the first `:`, lowercased; nil when there is none or it holds what a scheme cannot.
    static func scheme(of raw: String) -> String? {
        guard let colon = raw.firstIndex(of: ":") else { return nil }
        let head = raw[..<colon]
        guard let first = head.first, first.isLetter,
              head.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "+" || $0 == "-" || $0 == "." }) else { return nil }
        return head.lowercased()
    }
}
