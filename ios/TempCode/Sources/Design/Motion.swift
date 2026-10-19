import SwiftUI

/// The motion table of docs/IOS-DESIGN.md. Values are exact; nothing in the
/// app inlines a duration. Reduced motion swaps every translate and spring
/// for a cross-fade (`Motion.appear(reduced:)`).
enum Motion {
    /// Press on any row or button: scale 0.96, 160 ms ease-out, from the touch down.
    static let pressScale: CGFloat = 0.96
    static let press: Animation = .easeOut(duration: 0.16)

    /// Segment swipes settle with the drawer curve.
    static let drawer: Animation = .timingCurve(0.32, 0.72, 0, 1, duration: 0.5)

    /// Row expand (todo trace, tool body): a spring with no bounce; the content
    /// fades in 150 ms after the height starts; collapse is 200 ms ease-out.
    static let expand: Animation = .spring(duration: 0.35, bounce: 0)
    static let expandContent: Animation = .easeOut(duration: 0.15).delay(0.05)
    static let collapse: Animation = .easeOut(duration: 0.2)

    /// A needs-you row appearing: 200 ms ease-out, opacity and 8 pt of travel;
    /// leaving: 150 ms, opacity only.
    static let rowAppear: Animation = .easeOut(duration: 0.2)
    static let rowLeave: Animation = .easeOut(duration: 0.15)
    static let travel: CGFloat = 8

    /// The last-activity line, the dot becoming a spinner, the jump pill:
    /// 150 ms cross-fades; the activity line adds 2 pt of blur.
    static let crossFade: Animation = .easeOut(duration: 0.15)
    static let crossFadeBlur: CGFloat = 2

    /// A row's transition: travel and fade in, fade out; fades only under reduced motion.
    static func appear(reduced: Bool) -> AnyTransition {
        reduced
            ? .opacity
            : .asymmetric(insertion: .opacity.combined(with: .offset(y: travel)), removal: .opacity)
    }

    /// A line of text replaced in place: a cross-fade with a touch of blur, no height change.
    static func swap(reduced: Bool) -> AnyTransition {
        reduced
            ? .opacity
            : .modifier(active: Swap(blur: crossFadeBlur, opacity: 0), identity: Swap(blur: 0, opacity: 1))
    }

    private struct Swap: ViewModifier {
        let blur: CGFloat
        let opacity: Double

        func body(content: Content) -> some View {
            content.blur(radius: blur).opacity(opacity)
        }
    }
}
