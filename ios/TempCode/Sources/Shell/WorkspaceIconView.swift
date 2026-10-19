import SwiftUI
import TempCodeClient
import TempCodeContract
import UIKit

/// A workspace's mark as the desktop's `ProjectLogoIcon` resolves it: the
/// repo's own icon or the GitHub avatar (`workspace.icon`, cached on disk),
/// else the git host's mark, else a folder.
struct WorkspaceIconView: View {
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    var size: CGFloat = 20

    var body: some View {
        let icon = client.icons[workspace.id]
        Group {
            if let image = icon?.dataUrl.flatMap(IconImages.shared.image(for:)) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: size / 4, style: .continuous))
            } else if let host = icon?.host.flatMap(GitHost.init(rawValue:)) {
                HostMark(host: host)
                    .frame(width: size, height: size)
                    .foregroundStyle(.secondary)
            } else {
                Image(systemName: "folder")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(width: size, height: size)
            }
        }
        .task(id: workspace.id) { await client.loadIcon(workspace.id) }
    }
}

/// Decoded workspace icons by their data URL; small, so decoding at paint is fine.
final class IconImages: Sendable {
    static let shared = IconImages()
    private let cache = NSCache<NSString, UIImage>()

    private init() {
        cache.countLimit = 40
    }

    func image(for dataUrl: String) -> UIImage? {
        if let hit = cache.object(forKey: dataUrl as NSString) { return hit }
        guard let comma = dataUrl.firstIndex(of: ","), dataUrl.hasPrefix("data:"),
              let data = Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...])),
              let image = UIImage(data: data)
        else { return nil }
        cache.setObject(image, forKey: dataUrl as NSString)
        return image
    }
}
