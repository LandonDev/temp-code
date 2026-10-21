import SwiftUI
import TempCodeClient
import TempCodeContract
import UIKit

/// A workspace's mark as the desktop's `ProjectLogoIcon` resolves it: the
/// repo's own icon or the GitHub avatar (`workspace.icon`, cached on disk)
/// under a 1 px outline at 10 % (pure black in light, pure white in dark,
/// so it never tints the edge), else the git host's mark, else a folder.
/// The corner is a quarter of the size, concentric with the row's 8 pt.
struct WorkspaceIconView: View {
    let client: EnvironmentClient
    let workspace: WorkspaceMeta
    var size: CGFloat = 20
    @Environment(\.displayScale) private var scale
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let icon = client.icons[workspace.id]
        Group {
            if let image = icon?.dataUrl.flatMap(IconImages.shared.image(for:)) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: size / 4, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: size / 4, style: .continuous).strokeBorder(outline, lineWidth: 1 / scale))
            } else if let host = icon?.host.flatMap(GitHost.init(rawValue:)) {
                HostMark(host: host)
                    .frame(width: size, height: size)
                    .foregroundStyle(.secondary)
            } else {
                Image(systemName: "folder.fill")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(width: size, height: size)
            }
        }
        .task(id: workspace.id) { await client.loadIcon(workspace.id) }
    }

    /// Black at 10 % in light, white at 10 % in dark: never a gray that picks up the image.
    private var outline: Color {
        scheme == .dark ? Color.white.opacity(0.1) : Color.black.opacity(0.1)
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
