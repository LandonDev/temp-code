import SwiftUI
import TempCodeClient
import TempCodeContract

/// What a thread row can do without opening it: swipe leading to pin,
/// swipe trailing to archive (or bring back), and a context menu with
/// Rename, Pin, the caller's own rows, and Archive. Every action goes out
/// as its RPC and the `sessions` push brings the row's new state; a key
/// that cannot act sees the actions disabled with the reason as the menu's
/// first line. The swipe tints are the system's (orange pin, gray archive,
/// blue restore) and their glyphs filled, so the gestures read the same as
/// Mail's; the menu's glyphs are outline, like every menu's.
///
/// `menu` is the slot for a sibling's rows (Start now on a queued thread,
/// Resume on a stopped one): they render after Pin and before the Divider
/// that sets Archive apart.
struct ThreadRowActions<Rows: View>: ViewModifier {
    let client: EnvironmentClient
    let meta: SessionMeta
    let menu: Rows
    @State private var renaming = false
    @State private var failure: String?
    /// A thread that holds worktrees or simulators asks before archiving (thread iOS 20).
    @State private var archiving: ArchiveWithResourcesSheet.Target?

    private var block: ActionBlock? { client.operateBlock }

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                Button {
                    act { try await client.setPinned(meta.id, !meta.pinned) }
                } label: {
                    Label(meta.pinned ? "Unpin" : "Pin", systemImage: meta.pinned ? "pin.slash.fill" : "pin.fill")
                }
                .tint(Tint.warning)
                .disabled(block != nil)
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button {
                    act { try await archive() }
                } label: {
                    Label(meta.archived ? "Unarchive" : "Archive", systemImage: meta.archived ? "tray.and.arrow.up.fill" : "archivebox.fill")
                }
                .tint(meta.archived ? Tint.info : Color(.systemGray))
                .disabled(block != nil)
            }
            .contextMenu {
                if let block {
                    Text(block.text(now: Date().timeIntervalSince1970 * 1000))
                }
                Button {
                    renaming = true
                } label: {
                    Label("Rename…", systemImage: "pencil")
                }
                .disabled(block != nil)
                Button {
                    act { try await client.setPinned(meta.id, !meta.pinned) }
                } label: {
                    Label(meta.pinned ? "Unpin" : "Pin", systemImage: meta.pinned ? "pin.slash" : "pin")
                }
                .disabled(block != nil)
                menu
                Divider()
                Button(role: meta.archived ? nil : .destructive) {
                    act { try await archive() }
                } label: {
                    Label(meta.archived ? "Unarchive" : "Archive", systemImage: meta.archived ? "tray.and.arrow.up" : "archivebox")
                }
                .disabled(block != nil)
            }
            .sheet(isPresented: $renaming) { RenameSheet(client: client, session: meta) }
            .sheet(item: $archiving) { ArchiveWithResourcesSheet(target: $0) }
            // DEBUG proof: `TC_TEST_SHEET=rename` opens the sheet on the first row that appears.
            .onAppear { if TestHooks.sheet == "rename", TestHooks.once("rename") { renaming = true } }
            .alert("Couldn't do that", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(failure ?? "")
            }
    }

    private func act(_ body: @escaping () async throws -> Void) {
        Task {
            do {
                try await body()
            } catch {
                failure = (error as? ActionError)?.message ?? String(describing: error)
            }
        }
    }

    /// Archive through the prompt when the thread holds resources; unarchive at once.
    private func archive() async throws {
        if meta.archived {
            try await client.setArchived(meta.id, false)
        } else {
            try await ArchivePrompt.archive(client, meta) { archiving = $0 }
        }
    }
}

extension View {
    /// Swipe, context menu and the rename and failure alerts for one thread row.
    func threadRowActions(client: EnvironmentClient, meta: SessionMeta) -> some View {
        modifier(ThreadRowActions(client: client, meta: meta, menu: EmptyView()))
    }

    /// The same, with the caller's rows after Pin and before Archive.
    func threadRowActions<Rows: View>(client: EnvironmentClient, meta: SessionMeta, @ViewBuilder menu: () -> Rows) -> some View {
        modifier(ThreadRowActions(client: client, meta: meta, menu: menu()))
    }
}
