import PhotosUI
import SwiftUI
import TempCodeClient
import TempCodeContract

// The photos of the next turn. Each one goes up to the thread's host the
// moment it is picked (EnvironmentClient.upload: begin, one chunk at a
// time, commit) and shows above the field as a 56 pt thumbnail with a 2 pt
// bar along its foot while it travels. Removing a chip cancels its upload;
// a failed one keeps its chip with the bar in the destructive tint and
// Retry in its menu, and the send waits until it is retried or removed.

/// One photo on its way to the host: the bytes, what the thumbnail shows,
/// how far the upload is, and what the host answered.
@Observable
final class PhotoUpload: Identifiable {
    let id = UUID()
    let item: PhotosPickerItem
    /// `photo-<n>.<ext>`, the extension from the item's content type.
    let name: String
    let mime: String?
    private(set) var thumbnail: UIImage?
    private(set) var sent = 0
    private(set) var total = 0
    /// Why the upload stopped, until Retry.
    private(set) var failed: String?
    /// The file on the host, what the turn names.
    private(set) var committed: Attachment?
    private var data: Data?
    private var task: Task<Void, Never>?

    /// Thumbnails are decoded at this many points, three pixels each.
    static let thumbnailPoints: CGFloat = 56

    init(item: PhotosPickerItem, number: Int) {
        self.item = item
        let type = item.supportedContentTypes.first
        let ext = type?.preferredFilenameExtension ?? "jpeg"
        name = "photo-\(number).\(ext)"
        mime = type?.preferredMIMEType ?? "image/\(ext)"
    }

    /// Still reading or uploading: neither on the host nor failed.
    var inFlight: Bool { committed == nil && failed == nil }

    /// Bytes sent of the whole, 0…1.
    var fraction: Double { total > 0 ? min(1, Double(sent) / Double(total)) : 0 }

    /// Read the photo (once) and send it; a second call retries after a failure.
    func start(_ client: EnvironmentClient, sessionId: String) {
        task?.cancel()
        failed = nil
        sent = 0
        task = Task { await run(client, sessionId: sessionId) }
    }

    func cancel() {
        task?.cancel()
        task = nil
    }

    private func run(_ client: EnvironmentClient, sessionId: String) async {
        do {
            if data == nil {
                guard let loaded = try await item.loadTransferable(type: Data.self) else { throw PhotoError.unreadable }
                data = loaded
                total = loaded.count
                let side = Self.thumbnailPoints * 3
                thumbnail = await UIImage(data: loaded)?.byPreparingThumbnail(ofSize: CGSize(width: side, height: side))
            }
            guard let data else { return }
            committed = try await client.upload(sessionId, name: name, mime: mime, data: data) { sent, total in
                self.sent = sent
                self.total = total
            }
        } catch {
            // A cancelled upload is a removed chip: nothing to say.
            guard !Task.isCancelled else { return }
            failed = (error as? ActionError)?.message ?? (error as? PhotoError)?.message ?? String(describing: error)
        }
    }

    private enum PhotoError: Error {
        case unreadable

        var message: String { "Couldn't read the photo" }
    }
}

/// The row of photo chips above the field: a horizontal scroll of 56 pt
/// thumbnails at the row radius with a hairline, the upload bar along each
/// one's foot, and a remove control at the top trailing corner.
struct AttachmentStrip: View {
    let uploads: [PhotoUpload]
    let onRemove: (PhotoUpload) -> Void
    let onRetry: (PhotoUpload) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(Array(uploads.enumerated()), id: \.element.id) { index, upload in
                    AttachmentChip(upload: upload, position: index + 1, count: uploads.count, onRemove: { onRemove(upload) }, onRetry: { onRetry(upload) })
                        .transition(Motion.appear(reduced: reduceMotion))
                }
            }
        }
        .scrollIndicators(.hidden)
        .animation(Motion.crossFade, value: uploads.map(\.id))
    }
}

/// One photo: the thumbnail (the fill step until it is decoded), the bar in
/// the accent while it travels and in the destructive tint once it failed,
/// the remove control, and Retry in the context menu of a failed one.
private struct AttachmentChip: View {
    let upload: PhotoUpload
    let position: Int
    let count: Int
    let onRemove: () -> Void
    let onRetry: () -> Void
    @Environment(\.colorScheme) private var scheme

    private var size: CGFloat { PhotoUpload.thumbnailPoints }

    /// A 10 % outline in the scheme's ink, so a light photo still has an edge.
    private var outline: Color { (scheme == .dark ? Color.white : Color.black).opacity(0.1) }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let image = upload.thumbnail {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    Surface.fill
                }
            }
            .frame(width: size, height: size)
            .overlay(alignment: .bottomLeading) {
                if upload.committed == nil {
                    Rectangle()
                        .fill(upload.failed == nil ? Color.accentColor : Tint.destructive)
                        .frame(width: upload.failed == nil ? size * upload.fraction : size, height: 2)
                        .animation(Motion.numeric, value: upload.sent)
                }
            }
            .clipShape(RoundedRectangle.rowCorner)
            .hairlineBorder(RoundedRectangle.rowCorner, color: outline)
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(Color(.label))
                    .padding(2)
                    .background(Surface.chrome, in: Circle())
            }
            .buttonStyle(.pressable)
            .padding(4)
            .accessibilityLabel("Remove photo \(position)")
        }
        .contextMenu {
            if upload.failed != nil {
                Button("Retry", systemImage: "arrow.clockwise", action: onRetry)
            }
            Button("Remove", systemImage: "xmark", role: .destructive, action: onRemove)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }

    private var label: String {
        let base = "Photo \(position) of \(count)"
        if let failed = upload.failed { return "\(base), failed: \(failed)" }
        if upload.committed != nil { return base }
        return "\(base), uploading \(Int((upload.fraction * 100).rounded())) %"
    }
}
