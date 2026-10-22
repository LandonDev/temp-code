import SwiftUI

// Liquid Glass, behind one availability check. On iOS 26 and later every
// helper here is the system's glass (`glassEffect`, the glass button
// styles, `GlassEffectContainer`, `safeAreaBar` with its scroll edge
// effect), which already follows Reduce Transparency and Increase
// Contrast. Before iOS 26 the same call draws the thin material with a
// hairline ring, opaque on the chrome step under Reduce Transparency and
// with a full-strength ring under Increase Contrast. No screen writes
// `#available(iOS 26.0, *)` itself; it names these.
//
// Glass is for the functional layer that floats over content: the chat
// bar, the segment switcher, a floating pill, toolbar buttons. Never glass
// on glass, and never glass on a row or a card inside the content.

extension View {
    /// The view on glass in `shape` (a capsule by default). `tint` colors
    /// the glass for the one thing to do; `interactive` lets it respond to
    /// touch (scale and shimmer) on iOS 26, for a control that is its own
    /// button.
    func tcGlass<S: Shape>(in shape: S = Capsule(), tint: Color? = nil, interactive: Bool = false) -> some View {
        modifier(GlassSurface(shape: shape, tint: tint, interactive: interactive))
    }

    /// A glass button: the system's `.glass` style on iOS 26, else the
    /// pressable style on the thin material. `prominent` is
    /// `.glassProminent` (filled in the tint) for the one action that
    /// matters. Shape it with `.buttonBorderShape` (circle or capsule).
    @ViewBuilder
    func tcGlassButton(prominent: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            if prominent {
                buttonStyle(.glassProminent)
            } else {
                buttonStyle(.glass)
            }
        } else {
            buttonStyle(FallbackGlassButtonStyle(prominent: prominent))
        }
    }

    /// Names the view inside a `TCGlassContainer` so glass that appears and
    /// leaves morphs into its neighbour instead of fading on its own.
    @ViewBuilder
    func tcGlassID<ID: Hashable & Sendable>(_ id: ID, in namespace: Namespace.ID) -> some View {
        if #available(iOS 26.0, *) {
            glassEffectID(id, in: namespace)
        } else {
            self
        }
    }

    /// The bar that floats at the screen's bottom edge over scrolling
    /// content: `safeAreaBar` on iOS 26, so the content scrolls under it
    /// behind the soft scroll edge effect and no divider is drawn, with the
    /// app's own soft edge under it (`BottomEdgeFade`) so text passing
    /// beneath the glass never competes with the field; before iOS 26 a
    /// `safeAreaInset` on the bar material.
    @ViewBuilder
    func tcBottomBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        if #available(iOS 26.0, *) {
            safeAreaBar(edge: .bottom, spacing: 0) {
                bar().background(alignment: .top) { BottomEdgeFade() }
            }
            .scrollEdgeEffectStyle(.soft, for: .bottom)
        } else {
            safeAreaInset(edge: .bottom, spacing: 0) {
                bar().background(.bar)
            }
        }
    }
}

extension View {
    /// The navigation bar: on iOS 26 the system's, transparent over the
    /// content with its glass buttons and the scroll edge effect under
    /// them; before that the background step, always shown when `visible`
    /// (a screen whose content starts under the bar), else only once
    /// content scrolls beneath it.
    @ViewBuilder
    func tcNavigationBar(visible: Bool = true) -> some View {
        if #available(iOS 26.0, *) {
            self
        } else if visible {
            toolbarBackground(Surface.background, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
        } else {
            toolbarBackground(Surface.background, for: .navigationBar)
        }
    }
}

extension Shape where Self == AnyShape {
    /// A corner concentric with the container it sits in (a sheet, the
    /// screen's own corners) and never tighter than `minimum`:
    /// `ConcentricRectangle` on iOS 26, the `minimum` corner before.
    static func concentric(minimum: CGFloat) -> AnyShape {
        if #available(iOS 26.0, *) {
            AnyShape(ConcentricRectangle(corners: .concentric(minimum: .fixed(minimum)), isUniform: true))
        } else {
            AnyShape(RoundedRectangle.corner(minimum))
        }
    }
}

/// Glass siblings that sit close together blend and morph as one surface
/// (`GlassEffectContainer` on iOS 26; a plain stack of thin material
/// before). `spacing` is how near two pieces must be to merge.
struct TCGlassContainer<Content: View>: View {
    var spacing: CGFloat = GlassMetrics.mergeSpacing
    @ViewBuilder let content: Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

/// The soft edge under a floating bottom bar: the thin material fading in
/// from nothing 24 pt above the bar, and the background step fading in under
/// it, down to the screen's edge. Content that scrolls beneath blurs and
/// recedes instead of reading through the glass. Under Reduce Transparency
/// the material is the system's opaque one.
private struct BottomEdgeFade: View {
    static let lead: CGFloat = 24

    var body: some View {
        let fade = LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.45)], startPoint: .top, endPoint: .bottom)
        ZStack {
            Rectangle().fill(.ultraThinMaterial).mask(fade)
            LinearGradient(stops: [.init(color: Surface.background.opacity(0), location: 0), .init(color: Surface.background.opacity(0.85), location: 0.5)], startPoint: .top, endPoint: .bottom)
        }
        .padding(.top, -Self.lead)
        .ignoresSafeArea(edges: .bottom)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The lengths the glass pieces share.
enum GlassMetrics {
    /// Two glass pieces closer than this merge inside a container.
    static let mergeSpacing: CGFloat = 8

    /// The More menu's glyph: the bare ellipsis on iOS 26, where the toolbar's
    /// glass already draws the circle; the circled one before.
    static var moreSymbol: String {
        if #available(iOS 26.0, *) { "ellipsis" } else { "ellipsis.circle" }
    }
}

private struct GlassSurface<S: Shape>: ViewModifier {
    let shape: S
    let tint: Color?
    let interactive: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.displayScale) private var scale

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(Glass.regular.tint(tint).interactive(interactive), in: shape)
        } else {
            content
                .background {
                    if reduceTransparency {
                        shape.fill(tint ?? Surface.chrome)
                    } else {
                        shape.fill(.ultraThinMaterial)
                        if let tint { shape.fill(tint.opacity(0.85)) }
                    }
                }
                .overlay(shape.stroke(contrast == .increased ? Color(.label).opacity(0.5) : Surface.hairline, lineWidth: 1 / scale))
        }
    }
}

/// Before iOS 26: the glass button's look on the thin material, pressed the
/// way every button here is (scale 0.96 from the touch down).
private struct FallbackGlassButtonStyle: ButtonStyle {
    let prominent: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .foregroundStyle(prominent ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
            .tcGlass(tint: prominent ? Color.accentColor : nil)
            .contentShape(Capsule())
            .scaleEffect(configuration.isPressed && !reduceMotion ? Motion.pressScale : 1)
            .opacity(configuration.isPressed && reduceMotion ? Motion.pressDim : 1)
            .animation(Motion.press, value: configuration.isPressed)
    }
}
