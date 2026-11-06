import Foundation
import Observation
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
    /// The name typed in the draft row ("Name this thread"), at most
    /// `titleMax` characters; the first send makes it the thread's title.
    public var title: String?
    /// When the draft last changed, ms.
    public var updatedAt: Int

    /// The desktop's `DRAFT_TITLE_MAX`.
    public static let titleMax = 80

    public init(text: String = "", threadType: ThreadType = .chat, provider: ProviderId? = nil, model: String? = nil, reasoning: Reasoning? = nil, permission: PermissionPolicy? = nil, master: Bool = false, environmentId: String? = nil, title: String? = nil, updatedAt: Int = 0) {
        self.text = text
        self.threadType = threadType
        self.provider = provider
        self.model = model
        self.reasoning = reasoning
        self.permission = permission
        self.master = master
        self.environmentId = environmentId
        self.title = title
        self.updatedAt = updatedAt
    }

    /// The Master pick is a chat's alone.
    public var bornMaster: Bool { master && threadType == .chat }

    /// A name as the field keeps it: cut at `titleMax` characters, nil when empty.
    public static func cleanTitle(_ title: String) -> String? {
        title.isEmpty ? nil : String(title.prefix(titleMax))
    }

    /// What the draft keeps once its first send went out (`sent`, the draft
    /// as the send read it): what was written while the create was in
    /// flight. Text the send carried leaves; text added after it stays (a
    /// draft rewritten mid-flight stays whole, so no word is lost); a title
    /// changed since stays. The type, model and host stay with what is left.
    /// Nil when nothing is left.
    public func remaining(after sent: ProjectDraft) -> ProjectDraft? {
        var left = self
        if text == sent.text {
            left.text = ""
        } else if !sent.text.isEmpty, text.hasPrefix(sent.text) {
            left.text = String(text.dropFirst(sent.text.count).drop(while: \.isWhitespace))
        }
        if title == sent.title { left.title = nil }
        let empty = left.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (left.title ?? "").isEmpty
        return empty ? nil : left
    }
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
        caps.contains(.admin) ? nil : "Master needs an admin key"
    }

    /// The create a draft's first send makes, on the copy it starts in: its
    /// type, model, effort and mode, Master for a chat, the text as the
    /// first message (`DraftSend` decides whether the create carries it).
    public static func threadDraft(_ draft: ProjectDraft, workspaceId: String, projectId: String?, provider: ProviderId, model: String) -> ThreadDraft {
        var thread = ThreadDraft.thread(type: draft.threadType, workspaceId: workspaceId, projectId: projectId, provider: draft.provider ?? provider, model: draft.model ?? model, reasoning: draft.reasoning, permission: draft.permission, title: draft.title)
        thread.master = draft.bornMaster ? true : nil
        return thread
    }

    /// What `project.ensureLinked` needs from the caller's copy, the
    /// desktop's `ensureLinkedArgs`; nil while the project or its workspace
    /// carries no link id yet (the linker has not run).
    public static func ensureLinkedParams(project: ProjectMeta, workspace: WorkspaceMeta) -> Methods.ProjectEnsureLinked.Params? {
        guard let projectLink = project.linkId, !projectLink.isEmpty, let workspaceLink = workspace.linkId, !workspaceLink.isEmpty else { return nil }
        return .init(projectLinkId: projectLink, workspaceLinkId: workspaceLink, name: project.name, branch: project.branch, mode: project.mode, callerWorkspacePath: workspace.path, callerProjectCwd: project.cwd)
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

    /// Send waits for the host's catalog: before it lands the model is
    /// empty, and the host would skip the thread defaults. One send at a time.
    public static func canSend(text: String, sending: Bool, model: String) -> Bool {
        !sending && !model.isEmpty && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The photos picked while the create was in flight: each one the send
    /// carried leaves once, the rest stay.
    public static func remainingPhotos(_ current: [DraftPhoto], sent: [DraftPhoto]) -> [DraftPhoto] {
        var left = current
        for photo in sent {
            if let index = left.firstIndex(of: photo) { left.remove(at: index) }
        }
        return left
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

/// A draft's first send while its create is in flight, the desktop's
/// `draft` strip thread: a chip on the live row until the thread's meta
/// lands (`ThreadStrip.model`). `sessionId` arrives with the create's answer.
public struct DraftSending: Sendable, Hashable {
    public var environmentId: String
    /// The scope's lead workspace and project, for the stand-in meta.
    public var workspaceId: String
    public var projectId: String?
    /// The draft's title, else the message's first line.
    public var title: String
    public var threadType: ThreadType
    public var provider: ProviderId
    public var model: String
    public var sessionId: String?
    /// When the send began, ms.
    public var startedAt: Int

    public init(environmentId: String, workspaceId: String, projectId: String?, title: String, threadType: ThreadType, provider: ProviderId, model: String, sessionId: String? = nil, startedAt: Int) {
        self.environmentId = environmentId
        self.workspaceId = workspaceId
        self.projectId = projectId
        self.title = title
        self.threadType = threadType
        self.provider = provider
        self.model = model
        self.sessionId = sessionId
        self.startedAt = startedAt
    }

    /// What the chip says: the typed name, else the message's first line.
    public static func title(of draft: ProjectDraft, text: String) -> String {
        if let title = draft.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        return WatchWords.cutAtWord(line.trimmingCharacters(in: .whitespaces), max: 48)
    }

    /// The chip id: the thread's once the create answered, else one of the send's own.
    public var chipId: String { "\(environmentId):\(sessionId ?? "sending-\(startedAt)")" }

    /// The meta the chip draws until the real one lands: starting, so its glyph is the working mark.
    public var standIn: SessionMeta {
        SessionMeta(id: sessionId ?? "sending-\(startedAt)", parentId: nil, projectId: projectId, workspaceId: projectId == nil ? workspaceId : nil, threadType: threadType, planPath: nil, provider: provider, model: model, reasoning: .medium, agentType: .implementer, title: title, cwd: "", status: .starting, pinned: false, archived: false, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: startedAt, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, createdAt: startedAt, updatedAt: startedAt)
    }
}

/// `ProjectDrafts` in UserDefaults (`project.drafts.v1`), the photos in memory.
@MainActor @Observable
public final class ProjectDraftStore {
    public static let defaultsKey = "project.drafts.v1"
    /// The app's one store.
    public static let shared = ProjectDraftStore()
    @ObservationIgnored private let defaults: UserDefaults
    /// The draft a New thread just focused: its composer takes the keyboard, then clears it.
    public var focusRequest: String?
    public private(set) var drafts: ProjectDrafts
    /// Photos picked before the thread exists, by key; never written to disk.
    public private(set) var photos: [String: [DraftPhoto]] = [:]
    /// The first sends in flight, by key: the strip's chip until the meta lands.
    public private(set) var sending: [String: DraftSending] = [:]
    /// How long a change waits for the next before the drafts are written:
    /// the desktop's 500 ms, so typing never encodes every draft per key.
    @ObservationIgnored private let saveDelay: Duration
    @ObservationIgnored private var pendingSave: Task<Void, Never>?

    public init(defaults: UserDefaults = .standard, saveDelay: Duration = .milliseconds(500)) {
        self.defaults = defaults
        self.saveDelay = saveDelay
        drafts = defaults.data(forKey: Self.defaultsKey).flatMap { try? JSONDecoder().decode(ProjectDrafts.self, from: $0) } ?? ProjectDrafts()
    }

    private static func now() -> Int { Int(Date().timeIntervalSince1970 * 1_000) }

    public func draft(_ key: String) -> ProjectDraft? { drafts.draft(key, now: Self.now()) }

    /// Kept at once in memory; written after `saveDelay` of quiet.
    public func set(_ key: String, _ draft: ProjectDraft) {
        drafts.set(key, draft, now: Self.now())
        scheduleSave()
    }

    /// New thread: the draft takes the type asked for, keeps its text, and its composer takes the keyboard.
    @discardableResult
    public func focus(_ key: String, type: ThreadType?) -> ProjectDraft {
        let draft = drafts.focus(key, type: type, now: Self.now())
        save()
        focusRequest = key
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

    /// The first send went out: only what it carried leaves the draft
    /// (`ProjectDraft.remaining`, `DraftSend.remainingPhotos`).
    public func sent(_ key: String, draft sent: ProjectDraft, photos sentPhotos: [DraftPhoto]) {
        let photosLeft = DraftSend.remainingPhotos(photos[key] ?? [], sent: sentPhotos)
        let current = draft(key) ?? sent
        if let left = current.remaining(after: sent) {
            drafts.set(key, left, now: Self.now())
        } else if photosLeft.isEmpty {
            drafts.clear(key)
        } else {
            var bare = current
            bare.text = ""
            bare.title = nil
            drafts.set(key, bare, now: Self.now())
        }
        photos[key] = photosLeft.isEmpty ? nil : photosLeft
        save()
    }

    /// A first send began: the strip draws its chip.
    public func beginSending(_ key: String, _ chip: DraftSending) { sending[key] = chip }

    /// The create answered: the chip takes the thread's id and stands in until its meta lands.
    public func created(_ key: String, sessionId: String) { sending[key]?.sessionId = sessionId }

    /// The meta landed, or the send failed: the chip leaves.
    public func endSending(_ key: String) { sending[key] = nil }

    /// Writes now what waits for the quiet (the app leaving the foreground).
    public func flush() {
        guard pendingSave != nil else { return }
        save()
    }

    private func scheduleSave() {
        pendingSave?.cancel()
        let delay = saveDelay
        pendingSave = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.save()
        }
    }

    private func save() {
        pendingSave?.cancel()
        pendingSave = nil
        if let data = try? JSONEncoder().encode(drafts) { defaults.set(data, forKey: Self.defaultsKey) }
    }
}

extension EnvironmentClient {
    /// This host's copy of a linked project, found or made (`project.ensureLinked`, operate).
    public func ensureLinked(_ params: Methods.ProjectEnsureLinked.Params) async throws -> EnsureLinkedResult {
        if let block = operateBlock { throw ActionError.blocked(block) }
        do {
            return try await request(Methods.ProjectEnsureLinked.self, params)
        } catch {
            throw ActionError.wrap(error)
        }
    }

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
