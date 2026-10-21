import SwiftUI

/// The motion table of docs/IOS-DESIGN.md, one name per row. Values are
/// exact; nothing in the app inlines a duration, a curve or a travel. Every
/// transition here has a reduced-motion form: cross-fades replace every
/// translate and spring. The modifiers at the bottom read that setting
/// themselves, so a sibling applies `.rowAppearTransition()` and is done.
enum Motion {
    // MARK: Press

    /// Press on any row or button: scale 0.96, 160 ms ease-out, from the touch down.
    static let pressScale: CGFloat = 0.96
    static let press: Animation = .easeOut(duration: 0.16)
    /// Under reduced motion the pressed control dims to this instead of scaling.
    static let pressDim: Double = 0.6

    // MARK: Segments and sheets

    /// Segment swipes settle with the drawer curve, `cubic-bezier(0.32, 0.72, 0, 1)`.
    static let drawer: Animation = .timingCurve(0.32, 0.72, 0, 1, duration: 0.5)

    // MARK: Expand and collapse

    /// Row expand (todo trace, tool body): a spring with no bounce; the content
    /// fades in over 150 ms once the height starts; collapse is 200 ms ease-out.
    static let expand: Animation = .spring(duration: 0.35, bounce: 0)
    static let expandContent: Animation = .easeOut(duration: 0.15).delay(0.05)
    static let collapse: Animation = .easeOut(duration: 0.2)

    // MARK: Rows and lines

    /// A needs-you row appearing: 200 ms ease-out, opacity and 8 pt of travel;
    /// leaving: 150 ms, opacity only.
    static let rowAppear: Animation = .easeOut(duration: 0.2)
    static let rowLeave: Animation = .easeOut(duration: 0.15)
    static let travel: CGFloat = 8

    /// The last-activity line, the dot becoming a spinner, the jump pill:
    /// 150 ms cross-fades; the activity line adds 2 pt of blur.
    static let crossFade: Animation = .easeOut(duration: 0.15)
    static let crossFadeBlur: CGFloat = 2

    /// Counts and elapsed roll their digits (`contentTransition(.numericText())`)
    /// on the same 150 ms, so a ticking row never jitters.
    static let numeric: Animation = .easeOut(duration: 0.15)

    /// The jump-to-latest pill: 150 ms opacity and 8 pt of travel, both directions.
    static let jump: Animation = .easeOut(duration: 0.15)

    // MARK: Transitions

    /// A row's transition: travel and fade in over `rowAppear`, fade out over
    /// `rowLeave`; fades only under reduced motion. The timings ride on the
    /// transition, so the enclosing animation cannot stretch them.
    static func appear(reduced: Bool) -> AnyTransition {
        reduced
            ? .asymmetric(insertion: .opacity.animation(rowAppear), removal: .opacity.animation(rowLeave))
            : .asymmetric(
                insertion: .opacity.combined(with: .offset(y: travel)).animation(rowAppear),
                removal: .opacity.animation(rowLeave)
            )
    }

    /// A line of text replaced in place: a cross-fade with a touch of blur, no height change.
    static func swap(reduced: Bool) -> AnyTransition {
        reduced
            ? .opacity.animation(crossFade)
            : .modifier(active: Swap(blur: crossFadeBlur, opacity: 0), identity: Swap(blur: 0, opacity: 1)).animation(crossFade)
    }

    /// The jump pill and anything else that rises in and sinks out the same way.
    static func jump(reduced: Bool) -> AnyTransition {
        reduced
            ? .opacity.animation(jump)
            : .opacity.combined(with: .offset(y: travel)).animation(jump)
    }

    /// Run `body` with every animation off: the first paint from cache, a
    /// keyboard action, anything the doc says never animates.
    static func withoutAnimation<T>(_ body: () throws -> T) rethrows -> T {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        return try withTransaction(transaction, body)
    }

    private struct Swap: ViewModifier {
        let blur: CGFloat
        let opacity: Double

        func body(content: Content) -> some View {
            content.blur(radius: blur).opacity(opacity)
        }
    }
}

extension View {
    /// `Motion.appear`, reading reduced motion itself.
    func rowAppearTransition() -> some View {
        modifier(MotionTransition(kind: .appear))
    }

    /// `Motion.swap`, reading reduced motion itself. Pair it with `.id(text)`
    /// inside a `ZStack`, or use `SwapText`.
    func swapTransition() -> some View {
        modifier(MotionTransition(kind: .swap))
    }

    /// `Motion.jump`, reading reduced motion itself.
    func jumpTransition() -> some View {
        modifier(MotionTransition(kind: .jump))
    }
}

private struct MotionTransition: ViewModifier {
    enum Kind {
        case appear
        case swap
        case jump
    }

    let kind: Kind
    @Environment(\.accessibilityReduceMotion) private var reduced

    func body(content: Content) -> some View {
        switch kind {
        case .appear: content.transition(Motion.appear(reduced: reduced))
        case .swap: content.transition(Motion.swap(reduced: reduced))
        case .jump: content.transition(Motion.jump(reduced: reduced))
        }
    }
}
