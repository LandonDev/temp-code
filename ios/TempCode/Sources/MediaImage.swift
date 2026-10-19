import SwiftUI
import TempCodeClient
import TempCodeContract
import UIKit

/// An image attachment: `fs.media` names its `/asset/file` URL and the key
/// fetches it. Decoded images stay in a small memory cache.
struct MediaImage: View {
    let client: EnvironmentClient
    let path: String?
    let name: String
    @State private var image: UIImage?
    @State private var failed = false
    /// Thumbnails decode at the size they show (the width of a phone, 3× for the densest screen), never the original.
    static let displaySize = CGSize(width: 1_200, height: 960)

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 240)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
            } else if failed || path == nil {
                Label(name, systemImage: "photo")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                Shimmer(height: 120)
            }
        }
        .task(id: path) { await load() }
    }

    private func load() async {
        guard let path else { return }
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
    }

    func image(for key: String) -> UIImage? { cache.object(forKey: key as NSString) }
    func store(_ image: UIImage, for key: String) { cache.setObject(image, forKey: key as NSString) }
}
