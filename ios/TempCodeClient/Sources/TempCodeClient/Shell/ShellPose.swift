import Foundation

/// A window's size class along one axis, as the shell reads it: a package
/// enum so the rule needs no SwiftUI.
public enum SizeClass: Sendable, Hashable {
    case compact
    case regular
}

/// How the split lays its sidebar when the width is regular: beside the
/// detail (the window wider than tall) or over it behind the system toggle
/// (taller than wide: the detail takes the width).
public enum SidebarMode: Sendable, Hashable {
    case tiled
    case overlay
}

/// A list screen's title mode: large where there is height for it, inline
/// where there is not (a 96 pt title on a 466 pt screen leaves four rows).
public enum TitleDisplay: Sendable, Hashable {
    case large
    case inline
}

/// The shell's one shape fact, decided once at the root from the window's
/// size classes and its own bounds (never the idiom, the orientation or the
/// screen): compact width is the phone's stacks; regular width is a split
/// per tab. Every screen reads this, never `horizontalSizeClass`, for a
/// shell decision.
public enum ShellPose: Sendable, Hashable {
    /// The three stacks; `short` when the height is compact too (folded landscape).
    case stack(short: Bool)
    /// Sidebar and detail side by side (tiled) or the sidebar over the detail (overlay).
    case split(sidebar: SidebarMode)

    /// The rule. A nil size class (no window yet) reads as compact.
    public static func of(horizontal: SizeClass?, vertical: SizeClass?, size: CGSize) -> ShellPose {
        switch horizontal ?? .compact {
        case .compact:
            return .stack(short: vertical == .compact)
        case .regular:
            return .split(sidebar: size.width < size.height ? .overlay : .tiled)
        }
    }

    public var isSplit: Bool {
        if case .split = self { return true }
        return false
    }

    public var isStack: Bool { !isSplit }

    /// The overlay pose: the sidebar hides behind the system toggle.
    public var isOverlay: Bool { self == .split(sidebar: .overlay) }

    /// Inline titles only on the short stack.
    public var titleDisplay: TitleDisplay {
        if case .stack(short: true) = self { return .inline }
        return .large
    }
}
