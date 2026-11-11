import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

/// The host's read marks on the phone (CLAUDE.md "Read and unread: the host's
/// mark"): one mark per thread, the same on every client.
private func marked(_ id: String, updatedAt: Int, readAt: Int?, status: SessionStatus = .idle) -> SessionMeta {
    SessionMeta(id: id, parentId: nil, projectId: "p1", workspaceId: nil, threadType: .chat, planPath: nil, provider: .claude, model: "claude-sonnet-5-5", reasoning: .low, agentType: .implementer, title: id, cwd: "/tmp/repo", status: status, pinned: false, archived: false, permission: .edits, fast: false, ultrafast: false, context1m: false, busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil, readAt: readAt, createdAt: 1, updatedAt: updatedAt)
}

@Suite struct ReadMarksTests {
    @Test func `a host that keeps marks decides unread, one that does not leaves the phone's own`() {
        let marks = ReadMarks()
        let local = ["a": SeenMark(at: 100, seq: 3), "old": SeenMark(at: 100, seq: 1)]
        let sessions = [marked("a", updatedAt: 100, readAt: 0), marked("b", updatedAt: 100, readAt: 100), marked("old", updatedAt: 100, readAt: nil)]
        let seen = marks.merged(local: local, sessions: sessions, visible: nil)
        // Marked unread on another client: unread here though the phone saw it.
        #expect(ThreadGroups.isUnseen(sessions[0], seen: seen, floor: 0))
        #expect(seen["a"] == SeenMark(at: 0, seq: 3))
        // Read on another client: read here though the phone never looked.
        #expect(!ThreadGroups.isUnseen(sessions[1], seen: seen, floor: 0))
        // An older host: the phone's own mark.
        #expect(seen["old"] == SeenMark(at: 100, seq: 1))
    }

    @Test func `the thread on screen reads the phone's own mark`() {
        let seen = ReadMarks().merged(local: ["a": SeenMark(at: 100, seq: 1)], sessions: [marked("a", updatedAt: 100, readAt: 0)], visible: "a")
        #expect(seen["a"] == SeenMark(at: 100, seq: 1))
    }

    @Test func `a read is queued once, covers the thread until the host echoes it, and never goes past the row`() {
        var marks = ReadMarks()
        let a = marked("a", updatedAt: 100, readAt: 0)
        #expect(marks.read(a, at: 500))
        #expect(!marks.read(a))
        #expect(marks.queued == ["a": 100])
        #expect(marks.merged(local: [:], sessions: [a], visible: nil)["a"]?.at == 100)
        #expect(marks.take() == [.init(sessionId: "a", at: 100)])
        #expect(marks.queued.isEmpty)
        marks.heard(a)
        #expect(marks.pending == ["a": 100])
        marks.heard(marked("a", updatedAt: 100, readAt: 100))
        #expect(marks.pending.isEmpty)
        // Already read on the host: nothing to send.
        #expect(!marks.read(marked("b", updatedAt: 100, readAt: 100)))
        // A host that keeps no marks: nothing to send either.
        #expect(!marks.read(marked("c", updatedAt: 100, readAt: nil)))
    }

    @Test func `a failed request is queued again unless a newer mark took its place`() {
        var marks = ReadMarks()
        _ = marks.read(marked("a", updatedAt: 100, readAt: 0))
        let items = marks.take()
        _ = marks.read(marked("a", updatedAt: 200, readAt: 0))
        marks.requeue(items)
        #expect(marks.queued == ["a": 200])
        marks.forget(["a"])
        #expect(marks.queued.isEmpty && marks.pending.isEmpty)
    }
}
