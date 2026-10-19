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

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 320)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else if failed || path == nil {
                Label(name, systemImage: "photo")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(.tertiarySystemFill))
                    .frame(height: 120)
                    .overlay { ProgressView() }
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
              let decoded = UIImage(data: data)
        else {
            failed = true
            return
        }
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
