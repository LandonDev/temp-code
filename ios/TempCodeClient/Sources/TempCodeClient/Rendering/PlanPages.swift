import Foundation
import Observation

/// The plan pages' store: the last text of every plan on disk, so the next
/// open paints before the socket answers; the rendered document per page,
/// kept through a re-parse so a poll never drops the page to plain text;
/// and the reading position per page. A key is `"<environmentId>/<sessionId>"`,
/// so two hosts never share a slot.
@MainActor @Observable
public final class PlanPages {
    /// A page's rendered document: the one thing its view observes.
    @MainActor @Observable
    public final class Slot {
        public internal(set) var document: PlanDocument?
    }

    /// Texts at or under this size parse on a page's first paint instead
    /// of a frame of plain text.
    public static let syncLimit = 6 * 1024

    @ObservationIgnored private var texts: [String: String] = [:]
    @ObservationIgnored private var read: Set<String> = []
    @ObservationIgnored private var slots: [String: Slot] = [:]
    @ObservationIgnored private var ready: [String: PlanDocument] = [:]
    @ObservationIgnored private var inflight: [String: Int] = [:]
    @ObservationIgnored private let directory: URL
    @ObservationIgnored private let defaults: UserDefaults
    /// One serial queue, so consecutive polls land on disk in order.
    @ObservationIgnored private let disk = DispatchQueue(label: "dev.landon.tempcode.plan-cache", qos: .utility)
    /// Parses started, sync or off-actor; a test seam.
    @ObservationIgnored public private(set) var parses = 0

    /// `directory` defaults to `Caches/plans`; `defaults` holds the reading
    /// positions. Both are injectable so a test owns what it writes.
    public init(directory: URL? = nil, defaults: UserDefaults = .standard) {
        self.directory = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "plans", directoryHint: .isDirectory)
        self.defaults = defaults
    }

    /// The last text seen for a page, from memory, else from disk once.
    public func cached(_ key: String) -> String? {
        if let text = texts[key] { return text }
        guard !read.contains(key) else { return nil }
        read.insert(key)
        guard let text = try? String(contentsOf: url(key), encoding: .utf8) else { return nil }
        texts[key] = text
        return text
    }

    /// Keeps a page's live text for its next open: memory now, disk on the
    /// serial queue. The same text again writes nothing.
    public func remember(_ key: String, text: String) {
        guard texts[key] != text else { return }
        texts[key] = text
        read.insert(key)
        let file = url(key)
        let directory = directory
        disk.async {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? text.write(to: file, atomically: true, encoding: .utf8)
        }
    }

    /// Returns once every write queued so far has landed; a test seam.
    public func awaitDisk() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            disk.async { continuation.resume() }
        }
    }

    /// The document for this text: parsed now on a page's first paint when
    /// the text is short, otherwise off the main actor while the page keeps
    /// the document it had. A newer text supersedes a parse in flight: the
    /// stale one never lands.
    public func document(_ key: String, text: String) -> PlanDocument? {
        let hash = text.hashValue
        let slot = slot(key)
        if let document = slot.document, document.textHash == hash { return document }
        if let document = ready[key], document.textHash == hash { return document }
        if slot.document == nil, ready[key] == nil, text.utf8.count <= Self.syncLimit {
            parses += 1
            let document = PlanDocument.parse(text)
            ready[key] = document
            return document
        }
        if inflight[key] != hash {
            inflight[key] = hash
            parses += 1
            Task {
                let document = await PlanDocument.render(text)
                guard self.inflight[key] == hash else { return }
                self.inflight[key] = nil
                self.ready[key] = nil
                slot.document = document
            }
        }
        return slot.document ?? ready[key]
    }

    /// The first visible block's index on the page's last open; 0 when unset.
    public func position(_ key: String) -> Int {
        defaults.integer(forKey: Self.positionKey(key))
    }

    public func savePosition(_ key: String, _ index: Int) {
        defaults.set(index, forKey: Self.positionKey(key))
    }

    private static func positionKey(_ key: String) -> String { "plan.position.\(key)" }

    private func slot(_ key: String) -> Slot {
        if let slot = slots[key] { return slot }
        let slot = Slot()
        slots[key] = slot
        return slot
    }

    /// `Caches/plans/<safe key>.md`: letters, digits and `-` kept, every
    /// other scalar (the key's `/`, spaces) an underscore.
    func url(_ key: String) -> URL {
        directory.appending(path: "\(Self.fileName(key)).md")
    }

    static func fileName(_ key: String) -> String {
        String(key.unicodeScalars.map { scalar -> Character in
            switch scalar {
            case "A"..."Z", "a"..."z", "0"..."9", "-": Character(scalar)
            default: "_"
            }
        })
    }
}
