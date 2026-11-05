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
        #expect(ProjectDrafts.masterBlock(caps: [.read, .operate]) != nil)
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
        let reopened = ProjectDraftStore(defaults: defaults)
        #expect(reopened.draft("p")?.text == "saved")
        #expect(reopened.photos["p"] == nil)
        store.clear("p")
        #expect(store.photos["p"] == nil)
        #expect(ProjectDraftStore(defaults: defaults).draft("p") == nil)
    }
}
