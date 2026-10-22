import SwiftUI
import TempCodeClient
import TempCodeContract

/// What the inbox holds across the app: every host's last snapshot, kept on
/// disk so the tab paints at once on the next launch and never flashes; the
/// seen marks that decide a row's weight; and what the detail screens have
/// already loaded, so going back and in again paints from memory. The rules
/// are `InboxModel` in the client package; this is the storage.
@MainActor @Observable
final class InboxStore {
    static let shared = InboxStore()

    private(set) var snapshots: [String: GithubInboxSnapshot] = [:]
    /// The hosts whose snapshot was asked for in this process, answered or not.
    private(set) var asked: Set<String> = []
    /// When each host was last asked, so a reopened tab asks again only after a while.
    private var askedAt: [String: Date] = [:]
    /// A stored snapshot older than this is read again when the tab opens (the desktop may have refreshed it).
    static let reaskInterval: TimeInterval = 60
    private(set) var seen: [String: Int]
    private(set) var details: [String: GitHubWorkItemDetails] = [:]
    private(set) var threads: [String: GitHubWorkItemThread] = [:]
    private(set) var diffs: [String: GitHubPrDiff] = [:]

    private let defaults: UserDefaults
    private let directory: URL
    private static let seenKey = "inbox.seen"
    private static let seededKey = "inbox.seen.seeded"

    init(defaults: UserDefaults = .standard, directory: URL? = nil) {
        self.defaults = defaults
        self.directory = directory ?? Self.defaultDirectory()
        seen = (defaults.dictionary(forKey: Self.seenKey) as? [String: Int]) ?? [:]
        snapshots = Self.readSnapshots(in: self.directory)
    }

    // MARK: snapshots

    func snapshot(for environmentId: String) -> GithubInboxSnapshot? { snapshots[environmentId] }

    /// A host's snapshot, written through to disk. The first one ever seeds the seen marks.
    func put(_ snapshot: GithubInboxSnapshot, for environmentId: String) {
        markAsked(environmentId)
        snapshots[environmentId] = snapshot
        if !defaults.bool(forKey: Self.seededKey) {
            let now = Int(Date.now.timeIntervalSince1970 * 1000)
            seen.merge(InboxModel.seedSeen(snapshot, environmentId: environmentId, now: now)) { _, seeded in seeded }
            defaults.set(true, forKey: Self.seededKey)
            saveSeen()
        }
        let url = directory.appending(path: "\(environmentId).json")
        if let data = try? JSONEncoder().encode(snapshot) {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    func markAsked(_ environmentId: String) {
        asked.insert(environmentId)
        askedAt[environmentId] = .now
    }

    /// The host's stored snapshot is worth asking for: never asked in this process, or not for a minute.
    func shouldAsk(_ environmentId: String, now: Date = .now) -> Bool {
        guard let at = askedAt[environmentId] else { return true }
        return now.timeIntervalSince(at) >= Self.reaskInterval
    }

    /// The clients as the model reads them: id, name, and the snapshot held for each.
    func hosts(_ clients: [EnvironmentClient]) -> [InboxModel.Host] {
        clients.map { InboxModel.Host(environmentId: $0.environment.id, name: $0.environment.name, snapshot: snapshots[$0.environment.id]) }
    }

    /// Every item of every client, newest first, as the desktop sorts.
    func entries(clients: [EnvironmentClient]) -> [InboxEntry] {
        InboxModel.entries(hosts(clients))
    }

    // MARK: seen

    func isUnread(_ entry: InboxEntry) -> Bool { InboxModel.isUnread(entry, seen: seen) }

    func markRead(_ entry: InboxEntry) {
        InboxModel.markRead(entry, in: &seen)
        saveSeen()
    }

    func markUnread(_ entry: InboxEntry) {
        InboxModel.markUnread(entry, in: &seen)
        saveSeen()
    }

    private func saveSeen() {
        defaults.set(seen, forKey: Self.seenKey)
    }

    // MARK: detail

    func putDetails(_ value: GitHubWorkItemDetails, for id: String) { details[id] = value }
    func putThread(_ value: GitHubWorkItemThread, for id: String) { threads[id] = value }
    func putDiff(_ value: GitHubPrDiff, for id: String) { diffs[id] = value }

    // MARK: disk

    static func defaultDirectory() -> URL {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)) ?? FileManager.default.temporaryDirectory
        return base.appending(path: "TempCode/inbox", directoryHint: .isDirectory)
    }

    private static func readSnapshots(in directory: URL) -> [String: GithubInboxSnapshot] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path()) else { return [:] }
        var out: [String: GithubInboxSnapshot] = [:]
        let decoder = JSONDecoder()
        for name in names where name.hasSuffix(".json") {
            guard let data = try? Data(contentsOf: directory.appending(path: name)),
                  let snapshot = try? decoder.decode(GithubInboxSnapshot.self, from: data) else { continue }
            out[String(name.dropLast(5))] = snapshot
        }
        return out
    }
}

/// Each tone's one color; `plain` is the tertiary label, so the word sits
/// with the rest of the dim line.
extension InboxTone {
    var color: Color {
        switch self {
        case .info: Tint.info
        case .success: Tint.success
        case .warning: Tint.warning
        case .destructive: Tint.destructive
        case .violet: Tint.violet
        case .plain: Color(.tertiaryLabel)
        }
    }
}

/// A person's picture: the GitHub avatar once it lands, a letter until then,
/// both behind the same one-pixel outline (black or white at 10 %) so the
/// edge reads the same on every surface. Loaded once per process and kept.
/// The caller scales `size` with Dynamic Type.
struct InboxAvatar: View {
    let url: String
    let login: String
    let size: CGFloat
    @State private var image: UIImage?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            Circle().fill(Surface.fill)
            Text(String(login.prefix(1)).uppercased())
                .font(.system(size: size * 0.42, weight: .medium, design: .rounded))
                .foregroundStyle(.secondary)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .hairlineBorder(Circle(), color: scheme == .dark ? .white.opacity(0.1) : .black.opacity(0.1))
        .animation(Motion.crossFade, value: image == nil)
        .accessibilityHidden(true)
        .task(id: url) { await load() }
    }

    private func load() async {
        guard !url.isEmpty, let remote = URL(string: url) else {
            image = nil
            return
        }
        if let held = AvatarCache.shared.image(for: url) {
            image = held
            return
        }
        guard let (data, _) = try? await URLSession.shared.data(from: remote), let decoded = UIImage(data: data) else { return }
        let side = size * 3
        let prepared = await decoded.byPreparingThumbnail(ofSize: CGSize(width: side, height: side)) ?? decoded
        AvatarCache.shared.store(prepared, for: url)
        if !Task.isCancelled { image = prepared }
    }
}

/// Main-actor isolated, as the app's default makes it; the cache is only ever read from views.
final class AvatarCache {
    static let shared = AvatarCache()
    private let cache = NSCache<NSString, UIImage>()

    private init() { cache.countLimit = 200 }

    func image(for key: String) -> UIImage? { cache.object(forKey: key as NSString) }
    func store(_ image: UIImage, for key: String) { cache.setObject(image, forKey: key as NSString) }
}
