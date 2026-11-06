import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

private func meta(_ id: String, status: SessionStatus = .idle, type: ThreadType = .chat, isMaster: Bool? = nil, planCompletedAt: Int? = nil, agents: [String] = [], treeHasPaused: Bool? = nil) -> SessionMeta {
    SessionMeta(
        id: id, parentId: nil, projectId: "p", workspaceId: nil, threadType: type, planPath: nil, provider: .claude,
        model: "m", reasoning: .low, agentType: .implementer, title: id, cwd: "/r", status: status,
        pinned: false, archived: false, permission: .edits, fast: false, ultrafast: false, context1m: false,
        busySince: nil, pausedAt: nil, frozenActiveElapsed: nil, nativeId: nil,
        background: agents.isEmpty ? nil : SessionMeta.Background(tasks: [], agents: agents, batch: nil, watchingSince: nil),
        treeHasPaused: treeHasPaused, planCompletedAt: planCompletedAt, isMaster: isMaster, createdAt: 1, updatedAt: 1
    )
}

private func chip(_ meta: SessionMeta, selected: Bool = false, unseen: Bool = false) -> StripChip {
    StripChip(environmentId: "e", meta: meta, selected: selected, unseen: unseen, live: true, outside: false)
}

/// The desktop's chip (ThreadHeaderStrip.tsx): one glyph slot, the unread
/// weight, the Master word, the medium width always held.
@Suite struct StripChipTests {
    @Test func `the glyph slot holds the type at rest and the status mark while a state is worth one`() {
        #expect(chip(meta("a", type: .planning)).look(onShelf: false).glyph == .type(.planning))
        #expect(chip(meta("a", status: .done)).look(onShelf: false).glyph == .type(.chat))
        let marked: [(SessionMeta, CardState)] = [
            (meta("w", status: .running), .working),
            (meta("s", status: .starting), .working),
            (meta("q", status: .waiting), .waiting),
            (meta("f", status: .error), .failed),
            (meta("p", status: .paused), .paused),
            (meta("tp", status: .idle, treeHasPaused: true), .paused),
            (meta("u", status: .queued), .queued),
            (meta("v", status: .watching), .watching),
            (meta("g", status: .idle, agents: ["kid"]), .watching),
            (meta("x", status: .stopped), .stopped),
            (meta("r", status: .idle, type: .planning, planCompletedAt: 5), .planReady)
        ]
        for (meta, state) in marked {
            #expect(chip(meta).look(onShelf: false).glyph == .status(state), "\(meta.id)")
            // A shelf chip never marks.
            #expect(chip(meta).look(onShelf: true).glyph == .type(meta.threadType ?? .chat), "\(meta.id)")
        }
    }

    @Test func `unread is medium on the live row, never on the selected chip or the shelf, and the medium width is always held`() {
        #expect(chip(meta("a"), unseen: true).look(onShelf: false).medium)
        #expect(!chip(meta("a"), selected: true, unseen: true).look(onShelf: false).medium)
        #expect(!chip(meta("a"), unseen: true).look(onShelf: true).medium)
        #expect(!chip(meta("a")).look(onShelf: false).medium)
        // The room is measured at one weight whether the chip reads unread or read, so turning one never widens it.
        let read = chip(meta("a")).look(onShelf: false)
        let unread = chip(meta("a"), unseen: true).look(onShelf: false)
        #expect(read.titleWeight == .regular)
        #expect(unread.titleWeight == .medium)
        #expect(read.widthWeight == unread.widthWeight)
        #expect(read.widthWeight == .medium, "the room is the wider weight's")
        #expect(chip(meta("a"), unseen: true).look(onShelf: true).widthWeight == .medium)
    }

    @Test func `Master is said on a pinned master's live chip alone`() {
        #expect(chip(meta("m", isMaster: true)).look(onShelf: false).master)
        #expect(!chip(meta("m", isMaster: true)).look(onShelf: true).master)
        #expect(!chip(meta("a")).look(onShelf: false).master)
    }

    @Test func `compact width keeps a settled thread on screen at the live row's end, unsaved, out of the Recent menu`() {
        let live = chip(meta("w", status: .running))
        var shown = chip(meta("s"), selected: true)
        shown.live = false
        let other = StripChip(environmentId: "e", meta: meta("o"), selected: false, unseen: false, live: false, outside: false)
        let model = StripModel(live: [live], shelf: [shown, other])
        let compact = model.compact
        #expect(compact.live.map(\.meta.id) == ["w", "s"])
        #expect(compact.live.last?.outside == true)
        #expect(compact.shelf.map(\.meta.id) == ["o"])
        #expect(compact.saveIds == model.saveIds)
        #expect(StripModel(live: [live], shelf: [other]).compact == StripModel(live: [live], shelf: [other]))
    }
}
