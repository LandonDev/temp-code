import SwiftUI
import TempCodeClient

/// The shell's one shape fact (`ShellPose`), published by `RootView` from
/// the window's size classes and its own bounds. Every screen reads this,
/// never `horizontalSizeClass`, for a shell decision: the detail column's
/// own size class is the system's and is not promised.
extension EnvironmentValues {
    @Entry var shellPose: ShellPose = .stack(short: false)
}

extension SizeClass {
    init?(_ sizeClass: UserInterfaceSizeClass?) {
        switch sizeClass {
        case .compact?: self = .compact
        case .regular?: self = .regular
        default: return nil
        }
    }
}

extension TitleDisplay {
    var mode: NavigationBarItem.TitleDisplayMode {
        switch self {
        case .large: .large
        case .inline: .inline
        }
    }
}

extension View {
    /// A list screen's title in the pose's mode: large, inline on the short stack.
    func shellTitleDisplay() -> some View {
        modifier(ShellTitleDisplay())
    }
}

private struct ShellTitleDisplay: ViewModifier {
    @Environment(\.shellPose) private var pose

    func body(content: Content) -> some View {
        content.navigationBarTitleDisplayMode(pose.titleDisplay.mode)
    }
}
