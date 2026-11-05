import Foundation
import TempCodeContract

/// One remembered draft per project, the desktop's lib/projectDrafts.ts:
/// what the person was writing in a project before its thread existed.
/// Nothing reaches the host until the first send. Keyed by the project's
/// link key (`ProjectPairs.key`, so linked copies share it) or
/// `loose:<workspace key>` for a workspace's chats.
public struct ProjectDraft: Codable, Sendable, Hashable {
    public var text: String
    public var threadType: ThreadType
    public var provider: ProviderId?
    public var model: String?
    public var reasoning: Reasoning?
    public var permission: PermissionPolicy?
    /// A chat born a master (admin).
    public var master: Bool
    /// The host a project linked across hosts starts on.
    public var environmentId: String?
    /// When the draft last changed, ms.
    public var updatedAt: Int

    public init(text: String = "", threadType: ThreadType = .chat, provider: ProviderId? = nil, model: String? = nil, reasoning: Reasoning? = nil, permission: PermissionPolicy? = nil, master: Bool = false, environmentId: String? = nil, updatedAt: Int = 0) {
        self.text = text
        self.threadType = threadType
        self.provider = provider
        self.model = model
        self.reasoning = reasoning
        self.permission = permission
        self.master = master
        self.environmentId = environmentId
        self.updatedAt = updatedAt
    }

    /// The Master pick is a chat's alone.
    public var bornMaster: Bool { master && threadType == .chat }
}

/// The drafts by key: 64 keys, 30 days, the oldest dropped first.
public struct ProjectDrafts: Codable, Sendable, Hashable {
    public static let maxKeys = 64
    public static let maxAgeMs = 30 * 24 * 3_600 * 1_000

    public var entries: [String: ProjectDraft] = [:]

    public init() {}

    /// A workspace's chats.
    public static func looseKey(_ workspaceKey: String) -> String { "loose:\(workspaceKey)" }

    public func draft(_ key: String, now: Int) -> ProjectDraft? {
        guard let draft = entries[key], now - draft.updatedAt <= Self.maxAgeMs else { return nil }
        return draft
    }

    /// Writes the draft at `now`, pruning what is past its age and past the cap.
    public mutating func set(_ key: String, _ draft: ProjectDraft, now: Int) {
        var draft = draft
        draft.updatedAt = now
        entries[key] = draft
        entries = entries.filter { now - $0.value.updatedAt <= Self.maxAgeMs }
        if entries.count > Self.maxKeys {
            let keep = entries.sorted { ($0.value.updatedAt, $0.key) > ($1.value.updatedAt, $1.key) }.prefix(Self.maxKeys)
            entries = Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
        }
    }

    /// New thread of a type: the draft takes the type and keeps its text.
    /// A type other than chat drops the Master pick.
    public mutating func focus(_ key: String, type: ThreadType?, now: Int) -> ProjectDraft {
        var draft = draft(key, now: now) ?? ProjectDraft()
        if let type {
            draft.threadType = type
            if type != .chat { draft.master = false }
        }
        set(key, draft, now: now)
        return draft
    }

    /// The first send went out: the draft is done.
    public mutating func clear(_ key: String) {
        entries[key] = nil
    }

    /// Why a key cannot pick Master: the reason in its place, nil when it can.
    public static func masterBlock(caps: [Capability]) -> String? {
        caps.contains(.admin) ? nil : "Master threads need an admin key"
    }
}

/// How a draft's first send goes out. Without photos, one create that
/// stores the message as the thread's first row. With photos (a draft has
/// no session to upload into, so they waited in memory): the create, the
/// uploads into the new thread, then the send naming them; a failed send
/// archives the thread it made (`session.delete` is not the phone's).
public enum DraftSend {
    public enum Step: Sendable, Hashable {
        case create(firstMessage: String?)
        case upload(count: Int)
        case send
        case archiveOnFailure
    }

    public static func steps(text: String, photos: Int) -> [Step] {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if photos == 0 { return [.create(firstMessage: message.isEmpty ? nil : message)] }
        return [.create(firstMessage: nil), .upload(count: photos), .send, .archiveOnFailure]
    }
}

/// A photo picked into a draft, held for the run only.
public struct DraftPhoto: Sendable, Hashable {
    public var name: String
    public var mime: String?
    public var data: Data

    public init(name: String, mime: String?, data: Data) {
        self.name = name
        self.mime = mime
        self.data = data
    }
}

/// `ProjectDrafts` in UserDefaults (`project.drafts.v1`), the photos in memory.
@MainActor
public final class ProjectDraftStore {
    public static let defaultsKey = "project.drafts.v1"
    private let defaults: UserDefaults
    public private(set) var drafts: ProjectDrafts
    /// Photos picked before the thread exists, by key; never written to disk.
    public private(set) var photos: [String: [DraftPhoto]] = [:]

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        drafts = defaults.data(forKey: Self.defaultsKey).flatMap { try? JSONDecoder().decode(ProjectDrafts.self, from: $0) } ?? ProjectDrafts()
    }

    private static func now() -> Int { Int(Date().timeIntervalSince1970 * 1_000) }

    public func draft(_ key: String) -> ProjectDraft? { drafts.draft(key, now: Self.now()) }

    public func set(_ key: String, _ draft: ProjectDraft) {
        drafts.set(key, draft, now: Self.now())
        save()
    }

    @discardableResult
    public func focus(_ key: String, type: ThreadType?) -> ProjectDraft {
        let draft = drafts.focus(key, type: type, now: Self.now())
        save()
        return draft
    }

    public func addPhoto(_ key: String, _ photo: DraftPhoto) { photos[key, default: []].append(photo) }
    public func removePhoto(_ key: String, at index: Int) {
        guard photos[key]?.indices.contains(index) == true else { return }
        photos[key]?.remove(at: index)
    }

    public func clear(_ key: String) {
        drafts.clear(key)
        photos[key] = nil
        save()
    }

    private func save() {
        if let data = try? JSONEncoder().encode(drafts) { defaults.set(data, forKey: Self.defaultsKey) }
    }
}

extension EnvironmentClient {
    /// A draft's first send, `DraftSend`'s steps: the thread made with its
    /// first message stored by the create, or (with photos) made, given the
    /// photos, then sent, archived again when the send fails.
    public func sendDraft(_ draft: ThreadDraft, text: String, photos: [DraftPhoto]) async throws -> SessionMeta {
        var draft = draft
        let steps = DraftSend.steps(text: text, photos: photos.count)
        guard case .create(let first)? = steps.first else { throw ActionError.wrap(CancellationError()) }
        draft.firstMessage = first
        let meta = try await createThread(draft)
        guard !photos.isEmpty else { return meta }
        do {
            var attachments: [Attachment] = []
            for photo in photos {
                attachments.append(try await upload(meta.id, name: photo.name, mime: photo.mime, data: photo.data))
            }
            try await send(meta.id, text: text, attachments: attachments)
        } catch {
            try? await setArchived(meta.id, true)
            throw error
        }
        return meta
    }
}
