import SwiftUI
import TempCodeClient

/// Every sheet's presentation in one place (docs/IOS-DESIGN.md "Sheets on
/// the iPhone Duo"). The rule is the client package's `SheetRules.shape`;
/// this is its SwiftUI half: detents, sizing, the radius, the drag
/// indicator and the horizontal-bars opt-in. No sheet writes a detent, a
/// radius or a sizing itself; it names its kind.
extension EnvironmentValues {
    /// The window's size classes, published once at the root (RootView). A
    /// sheet reads these and never its own, because a form sheet's own
    /// width class is compact on every display.
    @Entry var windowClasses: WindowClasses = .phone
}

extension View {
    /// Shape this sheet's presentation by what it holds. Applied inside the
    /// sheet's body, on its root `NavigationStack`, where the presentation
    /// modifiers used to sit. `fitted` is the measured content height a
    /// confirm passes (its `.fitted` detent).
    func tcSheet(_ kind: SheetKind, fitted height: CGFloat? = nil) -> some View {
        modifier(SheetShapeModifier(kind: kind, fitted: height))
    }
}

private struct SheetShapeModifier: ViewModifier {
    let kind: SheetKind
    let fitted: CGFloat?
    @Environment(\.windowClasses) private var window

    func body(content: Content) -> some View {
        let shape = SheetRules.shape(kind, in: window)
        content
            .modifier(HorizontalBars(on: shape.horizontalBars))
            .presentationDetents(detents(shape))
            // One adapter type for every sizing: a branch per case would give the
            // sheet a new identity on a fold and drop its draft.
            .presentationSizing(SheetSizingAdapter(sizing: shape.sizing))
            .presentationCornerRadius(Radius.sheet)
            .presentationDragIndicator(shape.dragIndicator ? .visible : .hidden)
    }

    private func detents(_ shape: SheetShape) -> Set<PresentationDetent> {
        Set(shape.detents.map { detent in
            switch detent {
            case .medium: .medium
            case .large: .large
            case .fitted: .height(fitted ?? SheetShapeModifier.fittedFallback)
            }
        })
    }

    /// A confirm's height before its content has measured itself.
    static let fittedFallback: CGFloat = 280
}

/// The sheet-level opt-in to horizontal bars (iOS 27.1: on the Duo's inner
/// display the system lays a sheet's bars out in a vertical rail unless its
/// content asks otherwise; UIKit's `preferredVerticalBarBehavior` flows up
/// to the nearest presentation, which is the sheet). This is the one place
/// to change if the SDK's sheet-bar API moves. Stable per sheet, never
/// toggled per pose: Apple's rule for the behavior.
private struct HorizontalBars: ViewModifier {
    let on: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(iOS 27.1, *), on {
            content.toolbarVerticalBehavior(.disabled)
        } else {
            content
        }
    }
}

/// `SheetSizing` as the system's `PresentationSizing`, delegating to the
/// concrete sizing of each case.
private struct SheetSizingAdapter: PresentationSizing {
    let sizing: SheetSizing

    func proposedSize(for root: PresentationSizingRoot, context: PresentationSizingContext) -> ProposedViewSize {
        switch sizing {
        case .automatic:
            AutomaticPresentationSizing.automatic.proposedSize(for: root, context: context)
        case .form:
            FormPresentationSizing.form.proposedSize(for: root, context: context)
        case .formFitted:
            FormPresentationSizing.form.fitted(horizontal: false, vertical: true).proposedSize(for: root, context: context)
        case .page:
            PagePresentationSizing.page.proposedSize(for: root, context: context)
        }
    }
}

/// The window's size classes, read once where the root view sits and
/// published as `\.windowClasses` for every sheet under it.
struct WindowClassesPublisher: ViewModifier {
    @Environment(\.horizontalSizeClass) private var horizontal
    @Environment(\.verticalSizeClass) private var vertical

    func body(content: Content) -> some View {
        content.environment(\.windowClasses, WindowClasses(horizontal: Self.layoutClass(horizontal), vertical: Self.layoutClass(vertical)))
    }

    /// Unknown counts as compact: the phone's own shape.
    static func layoutClass(_ sizeClass: UserInterfaceSizeClass?) -> LayoutClass {
        sizeClass == .regular ? .regular : .compact
    }
}

extension View {
    /// On the root `TabView`: the window's size classes for every sheet (seam P1-a).
    func publishesWindowClasses() -> some View {
        modifier(WindowClassesPublisher())
    }
}
