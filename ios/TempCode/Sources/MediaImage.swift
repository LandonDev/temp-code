import SwiftUI
import TempCodeClient
import TempCodeContract
import UIKit

/// An image attachment: `fs.media` names its `/asset/file` URL and the key
/// fetches it. Decoded at the size it shows, kept in a small memory cache,
/// drawn with the 1 px outline every image carries, and copied from the
/// context menu. Nothing animates when the cached image paints.
struct MediaImage: View {
    let client: EnvironmentClient
    let path: String?
    let name: String
    @State private var image: UIImage?
    @State private var failed = false
    @Environment(\.displayScale) private var scale
    /// Thumbnails decode at the size they show (the width of a phone, 3× for the densest screen), never the original.
    static let displaySize = CGSize(width: 1_200, height: 960)
    /// The thumbnail's bounds in the user's field: the phone's width less the field's padding.
    static let maxHeight: CGFloat = 240

    init(client: EnvironmentClient, path: String?, name: String) {
        self.client = client
        self.path = path
        self.name = name
        _image = State(initialValue: path.flatMap { ImageCache.shared.image(for: $0) })
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: Self.maxHeight)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Radius.row, style: .continuous).strokeBorder(TranscriptStyle.imageOutline, lineWidth: 1 / scale))
                    .contextMenu {
                        Button("Copy Image", systemImage: "doc.on.doc") { UIPasteboard.general.image = image }
                    }
                    .accessibilityLabel(name)
            } else if failed || path == nil {
                Label(name, systemImage: "photo")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else {
                Shimmer(height: 120)
                    .frame(maxWidth: 200)
            }
        }
        .task(id: path) { await load() }
    }

    private func load() async {
        guard let path, image == nil else { return }
        if let cached = ImageCache.shared.image(for: path) {
            image = cached
            return
        }
        guard let media = try? await client.request(Methods.FsMedia.self, .init(path: path)),
              let url = URL(string: media.url), let host = url.host,
              let request = client.assetRequest(host: host, path: String(url.path.dropFirst())),
              let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let original = UIImage(data: data)
        else {
            failed = true
            return
        }
        // Decode at display size; a small image stays as it is.
        var prepared = await original.byPreparingThumbnail(ofSize: MediaImage.displaySize)
        if prepared == nil { prepared = await original.byPreparingForDisplay() }
        let decoded = prepared ?? original
        ImageCache.shared.store(decoded, for: path)
        image = decoded
    }
}

final class ImageCache: Sendable {
    static let shared = ImageCache()
    private let cache = NSCache<NSString, UIImage>()

    private init() {
        cache.countLimit = 60
        // Decoded bitmaps are large: cap the cache by cost, not count alone.
        cache.totalCostLimit = 64 * 1024 * 1024
    }

    func image(for key: String) -> UIImage? { cache.object(forKey: key as NSString) }
    func store(_ image: UIImage, for key: String) {
        let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
        cache.setObject(image, forKey: key as NSString, cost: cost)
    }
}
