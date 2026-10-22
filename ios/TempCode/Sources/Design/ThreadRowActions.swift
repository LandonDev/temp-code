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
struct ThreadRowActions<Menu: View>: ViewModifier {
    let client: EnvironmentClient
    let meta: SessionMeta
    let menu: () -> Menu
    @State private var renaming = false
    @State private var title = ""
    @State private var failure: String?

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
                    act { try await client.setArchived(meta.id, !meta.archived) }
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
                    title = meta.title
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
                menu()
                Divider()
                Button(role: meta.archived ? nil : .destructive) {
                    act { try await client.setArchived(meta.id, !meta.archived) }
                } label: {
                    Label(meta.archived ? "Unarchive" : "Archive", systemImage: meta.archived ? "tray.and.arrow.up" : "archivebox")
                }
                .disabled(block != nil)
            }
            .alert("Rename thread", isPresented: $renaming) {
                TextField("Title", text: $title)
                    .textInputAutocapitalization(.sentences)
                Button("Rename") { act { try await client.rename(meta.id, title: title.trimmingCharacters(in: .whitespaces)) } }
                    .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                Button("Cancel", role: .cancel) {}
            }
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
}

extension View {
    /// Swipe, context menu and the rename and failure alerts for one thread row.
    func threadRowActions(client: EnvironmentClient, meta: SessionMeta) -> some View {
        modifier(ThreadRowActions(client: client, meta: meta) { EmptyView() })
    }

    /// The same, with the caller's rows after Pin and before Archive.
    func threadRowActions<Menu: View>(client: EnvironmentClient, meta: SessionMeta, @ViewBuilder menu: @escaping () -> Menu) -> some View {
        modifier(ThreadRowActions(client: client, meta: meta, menu: menu))
    }
}
