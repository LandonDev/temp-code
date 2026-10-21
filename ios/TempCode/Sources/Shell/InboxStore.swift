import SwiftUI
import TempCodeClient
import TempCodeContract

/// One inbox item and the host it came from.
struct InboxEntry: Identifiable, Hashable {
    let environmentId: String
    let hostName: String
    let item: GithubInboxItem
    /// `updatedAt` in clock milliseconds, the unit `TimeFormat` reads.
    let updatedMs: Int

    var id: String { "\(environmentId):\(item.repo)#\(item.number)" }
}

/// What the inbox holds across the app: every host's last snapshot, kept on
/// disk so the tab paints at once on the next launch and never flashes; the
/// seen marks that decide a row's weight; and what the detail screens have
/// already loaded, so going back and in again paints from memory.
@MainActor @Observable
final class InboxStore {
    static let shared = InboxStore()

    private(set) var snapshots: [String: GithubInboxSnapshot] = [:]
    /// The hosts whose snapshot was asked for in this process, answered or not.
    private(set) var asked: Set<String> = []
    private(set) var seen: [String: Int]
    private(set) var details: [String: GitHubWorkItemDetails] = [:]
    private(set) var threads: [String: GitHubWorkItemThread] = [:]
    private(set) var diffs: [String: GithubPrDiff] = [:]

    private let defaults: UserDefaults
    private let directory: URL
    private static let seenKey = "inbox.seen"
    private static let seededKey = "inbox.seen.seeded"
    /// On the first snapshot ever, rows older than this are seen; the newer ones are what is new.
    private static let seedWindowMs = 24 * 60 * 60 * 1000

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
        asked.insert(environmentId)
        snapshots[environmentId] = snapshot
        seedSeen(from: snapshot, environmentId: environmentId)
        let url = directory.appending(path: "\(environmentId).json")
        if let data = try? JSONEncoder().encode(snapshot) {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    func markAsked(_ environmentId: String) { asked.insert(environmentId) }

    /// Every item of every client, newest first, as the desktop sorts.
    func entries(clients: [EnvironmentClient]) -> [InboxEntry] {
        var out: [InboxEntry] = []
        for client in clients {
            guard let snapshot = snapshots[client.environment.id] else { continue }
            for repo in snapshot.repos {
                for item in repo.items {
                    out.append(InboxEntry(environmentId: client.environment.id, hostName: client.environment.name, item: item, updatedMs: Self.ms(item.updatedAt)))
                }
            }
        }
        return out.sorted {
            if $0.updatedMs != $1.updatedMs { return $0.updatedMs > $1.updatedMs }
            if $0.item.repo != $1.item.repo { return $0.item.repo < $1.item.repo }
            if $0.item.kind.rawValue != $1.item.kind.rawValue { return $0.item.kind.rawValue < $1.item.kind.rawValue }
            return $0.item.number > $1.item.number
        }
    }

    // MARK: seen

    func isUnread(_ entry: InboxEntry) -> Bool {
        guard let mark = seen[entry.id] else { return true }
        return mark < entry.updatedMs
    }

    func markRead(_ entry: InboxEntry) {
        seen[entry.id] = max(entry.updatedMs, seen[entry.id] ?? 0)
        saveSeen()
    }

    func markUnread(_ entry: InboxEntry) {
        seen[entry.id] = nil
        saveSeen()
    }

    private func seedSeen(from snapshot: GithubInboxSnapshot, environmentId: String) {
        guard !defaults.bool(forKey: Self.seededKey) else { return }
        let cutoff = Int(Date.now.timeIntervalSince1970 * 1000) - Self.seedWindowMs
        for repo in snapshot.repos {
            for item in repo.items {
                let ms = Self.ms(item.updatedAt)
                if ms < cutoff { seen["\(environmentId):\(item.repo)#\(item.number)"] = ms }
            }
        }
        defaults.set(true, forKey: Self.seededKey)
        saveSeen()
    }

    private func saveSeen() {
        defaults.set(seen, forKey: Self.seenKey)
    }

    // MARK: detail

    func putDetails(_ value: GitHubWorkItemDetails, for id: String) { details[id] = value }
    func putThread(_ value: GitHubWorkItemThread, for id: String) { threads[id] = value }
    func putDiff(_ value: GithubPrDiff, for id: String) { diffs[id] = value }

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

    nonisolated static func ms(_ iso: String) -> Int {
        let date = (try? Date(iso, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)))
            ?? (try? Date(iso, strategy: .iso8601))
        guard let date else { return 0 }
        return Int(date.timeIntervalSince1970 * 1000)
    }
}

/// The one word a row carries beyond its title, in the color that means it.
/// Nothing for an open pull request that waits on nothing in particular.
struct InboxStatus: Hashable {
    let text: String
    let tint: Color?

    static func of(_ item: GithubInboxItem, viewer: String?) -> InboxStatus? {
        let isPr = item.kind.rawValue == "pr"
        switch item.state.rawValue {
        case "merged": return InboxStatus(text: "Merged", tint: Tint.violet)
        case "closed": return InboxStatus(text: "Closed", tint: isPr ? Tint.destructive : nil)
        default: break
        }
        guard isPr else { return nil }
        if item.draft { return InboxStatus(text: "Draft", tint: nil) }
        if item.reviewDecision.rawValue == "CHANGES_REQUESTED" { return InboxStatus(text: "Changes requested", tint: Tint.warning) }
        if let checks = item.checks?.rawValue, checks == "FAILURE" || checks == "ERROR" { return InboxStatus(text: "Checks failing", tint: Tint.destructive) }
        if item.reviewDecision.rawValue == "APPROVED" { return InboxStatus(text: "Approved", tint: Tint.success) }
        if let viewer, !viewer.isEmpty, item.reviewRequested.contains(where: { $0.caseInsensitiveCompare(viewer) == .orderedSame }) {
            return InboxStatus(text: "Your review", tint: Tint.info)
        }
        return nil
    }
}

/// The review a comment carries, as the desktop's `githubReviewStateLabel` says it.
enum InboxReviewState {
    static func label(_ state: String) -> (text: String, tint: Color?)? {
        switch state.uppercased() {
        case "APPROVED": ("Approved", Tint.success)
        case "CHANGES_REQUESTED": ("Requested changes", Tint.warning)
        case "DISMISSED": ("Dismissed", nil)
        default: nil
        }
    }
}

/// A person's picture: the GitHub avatar once it lands, a letter until then,
/// both behind the same hairline outline so the edge reads the same on every
/// surface. Loaded once per process and kept.
struct InboxAvatar: View {
    let url: String
    let login: String
    var size: CGFloat = 36
    @State private var image: UIImage?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            Circle().fill(Color(.tertiarySystemFill))
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
        .overlay(Circle().strokeBorder(outline, lineWidth: 1))
        .animation(Motion.crossFade, value: image == nil)
        .accessibilityHidden(true)
        .task(id: url) { await load() }
    }

    private var outline: Color {
        (scheme == .dark ? Color.white : Color.black).opacity(0.1)
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

final class AvatarCache: Sendable {
    static let shared = AvatarCache()
    private let cache = NSCache<NSString, UIImage>()

    private init() { cache.countLimit = 200 }

    func image(for key: String) -> UIImage? { cache.object(forKey: key as NSString) }
    func store(_ image: UIImage, for key: String) { cache.setObject(image, forKey: key as NSString) }
}
