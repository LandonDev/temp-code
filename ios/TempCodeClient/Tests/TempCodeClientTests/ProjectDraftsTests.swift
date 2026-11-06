import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// One remembered draft per project (lib/projectDrafts.ts on the phone):
/// keys, expiry, the type change that keeps the text, the first send that
/// clears it, the photo path, and who may pick Master.
@Suite struct ProjectDraftsTests {
    private let day = 24 * 3_600 * 1_000

    @Test func `a draft is kept per key and a workspace's chats have their own`() {
        var drafts = ProjectDrafts()
        drafts.set("link:pl", ProjectDraft(text: "fix the build"), now: 1)
        drafts.set(ProjectDrafts.looseKey("link:wl"), ProjectDraft(text: "a question"), now: 1)
        #expect(drafts.draft("link:pl", now: 2)?.text == "fix the build")
        #expect(drafts.draft("loose:link:wl", now: 2)?.text == "a question")
    }

    @Test func `a draft older than 30 days is gone, and the cap keeps the 64 newest`() {
        var drafts = ProjectDrafts()
        drafts.set("old", ProjectDraft(text: "x"), now: 0)
        #expect(drafts.draft("old", now: 31 * day) == nil)
        for i in 0..<70 { drafts.set("k\(i)", ProjectDraft(text: "\(i)"), now: 31 * day + i) }
        #expect(drafts.entries.count == ProjectDrafts.maxKeys)
        #expect(drafts.entries["k0"] == nil)
        #expect(drafts.entries["k69"] != nil)
    }

    @Test func `New thread of a type keeps the text, and a type other than chat drops Master`() {
        var drafts = ProjectDrafts()
        drafts.set("p", ProjectDraft(text: "plan it", threadType: .chat, master: true), now: 1)
        let planning = drafts.focus("p", type: .planning, now: 2)
        #expect(planning.text == "plan it")
        #expect(planning.threadType == .planning)
        #expect(!planning.master)
        #expect(!planning.bornMaster)
        let fresh = drafts.focus("new", type: nil, now: 3)
        #expect(fresh.text.isEmpty)
        #expect(fresh.threadType == .chat)
    }

    @Test func `the first send clears the draft`() {
        var drafts = ProjectDrafts()
        drafts.set("p", ProjectDraft(text: "go"), now: 1)
        drafts.clear("p")
        #expect(drafts.draft("p", now: 2) == nil)
    }

    @Test func `without photos one create carries the message; with photos create, upload, send, archive on failure`() {
        #expect(DraftSend.steps(text: "  hello  ", photos: 0) == [.create(firstMessage: "hello")])
        #expect(DraftSend.steps(text: "", photos: 0) == [.create(firstMessage: nil)])
        #expect(DraftSend.steps(text: "look", photos: 2) == [.create(firstMessage: nil), .upload(count: 2), .send, .archiveOnFailure])
    }

    @Test func `Master needs an admin key; a lesser key sees the reason`() {
        #expect(ProjectDrafts.masterBlock(caps: [.read, .operate, .approve, .admin]) == nil)
        #expect(ProjectDrafts.masterBlock(caps: [.read, .operate]) == "Master needs an admin key")
        let draft = ThreadDraft(threadType: .chat, provider: .claude, model: "m", master: true)
        #expect(draft.needs == .admin)
        #expect(draft.params.master == true)
    }

    @Test func `the create carries the first message and leaves Master out when unpicked`() {
        let draft = ThreadDraft(threadType: .chat, provider: .claude, model: "m", firstMessage: "hi")
        #expect(draft.params.firstMessage == "hi")
        #expect(draft.params.master == nil)
        #expect(draft.needs == .operate)
    }

    @MainActor @Test func `the store keeps text on disk and photos in memory only`() throws {
        let defaults = try #require(UserDefaults(suiteName: "drafts-\(UUID().uuidString)"))
        let store = ProjectDraftStore(defaults: defaults)
        store.set("p", ProjectDraft(text: "saved"))
        store.addPhoto("p", DraftPhoto(name: "a.png", mime: "image/png", data: Data([1, 2, 3])))
        store.flush()
        let reopened = ProjectDraftStore(defaults: defaults)
        #expect(reopened.draft("p")?.text == "saved")
        #expect(reopened.photos["p"] == nil)
        store.clear("p")
        #expect(store.photos["p"] == nil)
        #expect(ProjectDraftStore(defaults: defaults).draft("p") == nil)
    }
}

@Suite struct DraftSendInFlightTests {
    private let photoA = DraftPhoto(name: "a.png", mime: "image/png", data: Data([1]))
    private let photoB = DraftPhoto(name: "b.png", mime: "image/png", data: Data([2]))

    @Test func `only what the send carried leaves the draft`() {
        let sent = ProjectDraft(text: "Fix the login", threadType: .implementation, title: "Login")
        // Nothing written meanwhile: the draft is done.
        #expect(sent.remaining(after: sent) == nil)
        // Words added after the send began stay; the sent words and the unchanged title leave.
        var more = sent
        more.text = "Fix the login\n\nand the logout too"
        let left = more.remaining(after: sent)
        #expect(left?.text == "and the logout too")
        #expect(left?.title == nil)
        #expect(left?.threadType == .implementation)
        // A draft rewritten mid-flight stays whole; a title changed since stays.
        var rewritten = sent
        rewritten.text = "Fix the signup"
        rewritten.title = "Signup"
        #expect(rewritten.remaining(after: sent)?.text == "Fix the signup")
        #expect(rewritten.remaining(after: sent)?.title == "Signup")
        // Photos: each one sent leaves once, one picked meanwhile stays.
        #expect(DraftSend.remainingPhotos([photoA, photoB], sent: [photoA]) == [photoB])
        #expect(DraftSend.remainingPhotos([photoA], sent: [photoA]).isEmpty)
    }

    @Test func `send waits for the catalog's model and for the send in flight`() {
        #expect(!DraftSend.canSend(text: "hi", sending: false, model: ""))
        #expect(!DraftSend.canSend(text: "hi", sending: true, model: "claude-sonnet-5-5"))
        #expect(!DraftSend.canSend(text: "  \n", sending: false, model: "claude-sonnet-5-5"))
        #expect(DraftSend.canSend(text: "hi", sending: false, model: "claude-sonnet-5-5"))
    }

    @Test func `the name is cut at 80 characters and rides the create; an empty one is no title`() {
        #expect(ProjectDraft.cleanTitle(String(repeating: "a", count: 90))?.count == ProjectDraft.titleMax)
        #expect(ProjectDraft.cleanTitle("") == nil)
        let named = ProjectDrafts.threadDraft(ProjectDraft(text: "go", title: "Ship the export"), workspaceId: "w", projectId: "p", provider: .claude, model: "m")
        #expect(named.params.title == "Ship the export")
        let blank = ProjectDrafts.threadDraft(ProjectDraft(text: "go", title: "  "), workspaceId: "w", projectId: "p", provider: .claude, model: "m")
        #expect(blank.params.title == nil)
    }

    @Test func `an old draft on disk without a name still reads`() throws {
        let old = Data(#"{"entries":{"p":{"text":"hi","threadType":"chat","master":false,"updatedAt":5}}}"#.utf8)
        let drafts = try JSONDecoder().decode(ProjectDrafts.self, from: old)
        #expect(drafts.entries["p"]?.text == "hi")
        #expect(drafts.entries["p"]?.title == nil)
    }

    @MainActor @Test func `the store writes after a quiet spell, or at once on flush`() async throws {
        let defaults = try #require(UserDefaults(suiteName: "drafts-quiet-\(UUID().uuidString)"))
        let store = ProjectDraftStore(defaults: defaults, saveDelay: .milliseconds(80))
        for text in ["a", "ab", "abc"] { store.set("p", ProjectDraft(text: text)) }
        #expect(store.draft("p")?.text == "abc")
        #expect(defaults.data(forKey: ProjectDraftStore.defaultsKey) == nil)
        // Written once the quiet passes (polled: a loaded run's main actor may be late).
        for _ in 0..<100 where defaults.data(forKey: ProjectDraftStore.defaultsKey) == nil { try await Task.sleep(for: .milliseconds(50)) }
        #expect(ProjectDraftStore(defaults: defaults).draft("p")?.text == "abc")
        store.set("p", ProjectDraft(text: "abcd"))
        store.flush()
        #expect(ProjectDraftStore(defaults: defaults).draft("p")?.text == "abcd")
    }

    @MainActor @Test func `a send keeps what was written while it ran, and its chip lives until the meta lands`() throws {
        let defaults = try #require(UserDefaults(suiteName: "drafts-sent-\(UUID().uuidString)"))
        let store = ProjectDraftStore(defaults: defaults)
        let sent = ProjectDraft(text: "first")
        store.set("p", sent)
        store.addPhoto("p", photoA)
        store.beginSending("p", DraftSending(environmentId: "e", workspaceId: "w", projectId: "p1", title: "first", threadType: .chat, provider: .claude, model: "m", startedAt: 7))
        #expect(store.sending["p"]?.chipId == "e:sending-7")
        // Written while the create ran.
        store.set("p", ProjectDraft(text: "first second"))
        store.addPhoto("p", photoB)
        store.created("p", sessionId: "s1")
        store.sent("p", draft: sent, photos: [photoA])
        #expect(store.draft("p")?.text == "second")
        #expect(store.photos["p"] == [photoB])
        #expect(store.sending["p"]?.chipId == "e:s1")
        store.endSending("p")
        #expect(store.sending["p"] == nil)
        // Nothing written meanwhile: the draft is gone.
        store.sent("p", draft: ProjectDraft(text: "second"), photos: [photoB])
        #expect(store.draft("p") == nil)
        #expect(store.photos["p"] == nil)
    }

    @Test func `the chip says the name, else the message's first line`() {
        #expect(DraftSending.title(of: ProjectDraft(title: "Named"), text: "body") == "Named")
        #expect(DraftSending.title(of: ProjectDraft(), text: "Look at the build\nmore") == "Look at the build")
    }

    @Test func `a picker moved to another host loads that host's catalog, and drops an answer it no longer wants`() {
        var load = CatalogLoad()
        let first = load.begin("mac"), again = load.begin("mac"), moved = load.begin("box")
        #expect(first && !again && moved)
        #expect(!load.lands("mac"))
        #expect(load.lands("box"))
        load.failed("box")
        let retried = load.begin("box")
        #expect(retried)
    }
}

@MainActor
@Suite struct DraftSendTests {
    private func draft(_ text: String) -> ThreadDraft {
        var thread = ProjectDrafts.threadDraft(ProjectDraft(text: text, threadType: .chat), workspaceId: "w1", projectId: "p1", provider: .claude, model: "claude-sonnet-5-5")
        thread.firstMessage = nil
        return thread
    }

    @Test func `a draft without photos is one create that stores the first message`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        let sending = Task { try await rig.client.sendDraft(draft("Map the plugin boundaries"), text: "Map the plugin boundaries", photos: []) }
        let create = try #require(await rig.request(fake, "session.create"))
        guard case .object(let params) = create.params else { throw TransportError.notConnected }
        #expect(params["firstMessage"] == .string("Map the plugin boundaries"))
        #expect(params["projectId"] == .string("p1"))
        fake.answer(id: create.id, result: json(sampleSession("s9")))
        let meta = try await sending.value
        #expect(meta.id == "s9")
        #expect(fake.sentRequests.contains { $0.method == "session.send" } == false, "the create carried the message")
        await rig.client.stop()
    }

    @Test func `with photos the thread is made, given the photos, then sent; a failed send archives it`() async throws {
        let rig = try ActingRig()
        let fake = try await rig.open()
        let photo = DraftPhoto(name: "photo-1.jpeg", mime: "image/jpeg", data: Data(repeating: 7, count: 4))
        let sending = Task { try await rig.client.sendDraft(draft("See this"), text: "See this", photos: [photo]) }
        let create = try #require(await rig.request(fake, "session.create"))
        guard case .object(let params) = create.params else { throw TransportError.notConnected }
        #expect(params["firstMessage"] == nil, "the photos must be on the host before the message names them")
        fake.answer(id: create.id, result: json(sampleSession("s9")))
        let begin = try #require(await rig.request(fake, "attachment.begin"))
        fake.answer(id: begin.id, result: #"{"uploadId":"u1","chunkBytes":4}"#)
        let chunk = try #require(await rig.request(fake, "attachment.chunk"))
        fake.answer(id: chunk.id, result: #"{"received":4}"#)
        let commit = try #require(await rig.request(fake, "attachment.commit"))
        fake.answer(id: commit.id, result: #"{"path":"/tmp/repo/.temp-code/attachments/s9/photo-1.jpeg","name":"photo-1.jpeg","mime":"image/jpeg","kind":"image","size":4}"#)
        let send = try #require(await rig.request(fake, "session.send"))
        fake.refuse(id: send.id, error: "the harness would not start")
        let archive = try #require(await rig.request(fake, "session.archive"))
        #expect(archive.params == .object(["sessionId": .string("s9"), "archived": .bool(true)]))
        fake.answer(id: archive.id, result: "null")
        await #expect(throws: ActionError.self) { try await sending.value }
        await rig.client.stop()
    }

    @Test func `Master rides the create for a chat alone, and takes an admin key`() {
        let chat = ProjectDrafts.threadDraft(ProjectDraft(threadType: .chat, master: true), workspaceId: "w1", projectId: nil, provider: .claude, model: "m")
        #expect(chat.master == true && chat.needs == .admin)
        let plan = ProjectDrafts.threadDraft(ProjectDraft(threadType: .planning, master: true), workspaceId: "w1", projectId: nil, provider: .claude, model: "m")
        #expect(plan.master == nil && plan.needs == .operate)
        let picked = ProjectDrafts.threadDraft(ProjectDraft(threadType: .implementation, provider: .codex, model: "gpt-6.1-sol", reasoning: .high, permission: .auto), workspaceId: "w1", projectId: "p1", provider: .claude, model: "m")
        #expect(picked.provider == .codex && picked.model == "gpt-6.1-sol" && picked.reasoning == .high)
        #expect(picked.needs == .approve, "full access takes approve")
    }

    @Test func `New copy needs both link ids, the desktop's ensureLinkedArgs`() {
        let project = ProjectMeta(id: "p1", workspaceId: "w1", name: "temp-code", mode: .local, branch: "master", cwd: "/repo", archived: false, accountPins: nil, preamble: nil, preambleEnabled: nil, linkId: "pl_1", settingsUpdatedAt: nil, createdAt: 1)
        let workspace = WorkspaceMeta(id: "w1", name: "work", path: "/work", git: true, accountPins: nil, githubRepo: nil, githubRepoCheckedAt: nil, preamble: nil, preambleEnabled: nil, linkId: "wl_1", createdAt: 1)
        let params = ProjectDrafts.ensureLinkedParams(project: project, workspace: workspace)
        #expect(params?.projectLinkId == "pl_1" && params?.workspaceLinkId == "wl_1")
        #expect(params?.callerProjectCwd == "/repo" && params?.callerWorkspacePath == "/work" && params?.branch == "master")
        let unlinked = WorkspaceMeta(id: "w1", name: "work", path: "/work", git: true, accountPins: nil, githubRepo: nil, githubRepoCheckedAt: nil, preamble: nil, preambleEnabled: nil, linkId: nil, createdAt: 1)
        #expect(ProjectDrafts.ensureLinkedParams(project: project, workspace: unlinked) == nil)
    }

    @Test func `New thread focuses the draft: the composer is asked to take the keyboard`() throws {
        let defaults = try #require(UserDefaults(suiteName: "draft-focus-\(UUID().uuidString)"))
        let store = ProjectDraftStore(defaults: defaults)
        store.set("link:pl_1", ProjectDraft(text: "half a thought"))
        let focused = store.focus("link:pl_1", type: .planning)
        #expect(focused.text == "half a thought" && focused.threadType == .planning)
        #expect(store.focusRequest == "link:pl_1")
    }
}
