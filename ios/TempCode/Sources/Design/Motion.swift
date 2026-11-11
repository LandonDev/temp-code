import SwiftUI
import TempCodeClient
import UIKit

/// The motion table of docs/IOS-DESIGN.md, one name per row. The numbers
/// are the desktop's, held once in the client package's `MotionValues`
/// (scripts/ios-motion-parity.test.ts compares them with index.css and
/// lib/ease.ts); this file only turns them into SwiftUI animations. Nothing
/// in the app inlines a duration, a curve or a travel. Every transition here
/// has a reduced-motion form: cross-fades replace every translate and
/// spring. The modifiers at the bottom read that setting themselves, so a
/// sibling applies `.rowAppearTransition()` and is done.
enum Motion {
    /// A `MotionValues` curve over `seconds`. SwiftUI's `.easeOut` is CSS's
    /// weaker `(0, 0, 0.58, 1)` and is never used here.
    static func curve(_ curve: MotionValues.Curve, _ seconds: Double) -> Animation {
        .timingCurve(curve.x1, curve.y1, curve.x2, curve.y2, duration: seconds)
    }

    /// The desktop's ease-out over `seconds`: fast out of the gate, a long settle.
    static func out(_ seconds: Double) -> Animation {
        curve(MotionValues.easeOut, seconds)
    }

    static func spring(_ values: MotionValues.Spring) -> Animation {
        .spring(Spring(mass: values.mass, stiffness: values.stiffness, damping: values.damping))
    }

    // MARK: The desktop's steps

    /// `--dur-fast` on ease-out: a fade, a first appearance.
    static let fast: Animation = out(MotionValues.fast)
    /// `--dur-base` on ease-out: a step landing, a chevron turning.
    static let base: Animation = out(MotionValues.base)
    /// `SPRING_LAYOUT`: a row gliding into place, a fold opening, a slot rising.
    static let layout: Animation = spring(MotionValues.springLayout)
    /// `SPRING_GLIDE`: a released drag settling.
    static let glide: Animation = spring(MotionValues.springGlide)
    /// The morph's two halves on the swap curve.
    static let swapOut: Animation = curve(MotionValues.easeSwap, MotionValues.swapOut)
    static let swapIn: Animation = curve(MotionValues.easeSwap, MotionValues.base)
    /// A newly sent bubble rising.
    static let rise: Animation = curve(MotionValues.easeDrawer, MotionValues.slow)

    // MARK: Press

    /// Press on any row or button: scale 0.96 on ease-out, from the touch down.
    static let pressScale = CGFloat(MotionValues.pressScale)
    static let press: Animation = out(MotionValues.press)
    /// Under reduced motion the pressed control dims to this instead of scaling.
    static let pressDim = MotionValues.pressDim

    // MARK: Segments and sheets

    /// Segment swipes settle on the drawer curve.
    static let drawer: Animation = curve(MotionValues.easeDrawer, MotionValues.drawer)

    // MARK: Expand and collapse

    /// Row expand (todo trace, tool body): the layout spring; the content
    /// fades in once the height starts; collapse is `base` on ease-out.
    static let expand: Animation = layout
    static let expandContent: Animation = out(MotionValues.fast).delay(MotionValues.swapOut)
    static let collapse: Animation = base
    /// A step landing where it lands.
    static let stepIn: Animation = base

    // MARK: Rows and lines

    /// A row appearing: `base`, opacity and a short travel; leaving: `fast`, opacity only.
    static let rowAppear: Animation = base
    static let rowLeave: Animation = fast
    static let travel: CGFloat = 4

    /// A cross-fade: the dot becoming a spinner, a line replaced in place.
    static let crossFade: Animation = fast
    static let crossFadeBlur: CGFloat = 2

    /// Counts and elapsed roll their digits (`contentTransition(.numericText())`)
    /// on the same fade, so a ticking row never jitters.
    static let numeric: Animation = fast

    /// The jump-to-latest pill.
    static let jump: Animation = fast

    // MARK: The working line

    /// The word morph's lift: the old words rise this far as they leave, the new from this far below.
    static let morphLift = CGFloat(MorphModel.lift)
    /// The closing line's words slide from past the glyph slot to the prose edge on the morph's arrival.
    static let settleSlide: Animation = swapIn

    /// One dot of the working mark (MARK in lib/ease.ts): where it rests and
    /// where it gathers to, and when in the period (`MotionValues.markLoop`).
    struct MarkDot {
        let restX: CGFloat
        let gatheredX: CGFloat
        let gatheredScale: CGFloat
        let gather: Double
        let part: Double

        /// Its x through one period, in points.
        var x: MotionLoop { MotionValues.markLoop(rest: restX, gathered: gatheredX, gather: gather, part: part) }
        /// Its scale through one period.
        var scale: MotionLoop { MotionValues.markLoop(rest: 1, gathered: gatheredScale, gather: gather, part: part) }
    }

    /// Left, middle, right; the right runs behind the left, so the three drift rather than clap.
    static let markDots = [
        MarkDot(restX: -CGFloat(MotionValues.markSpread), gatheredX: -1, gatheredScale: CGFloat(MotionValues.markSideScale), gather: MotionValues.markGather, part: MotionValues.markPart),
        MarkDot(restX: 0, gatheredX: 0, gatheredScale: CGFloat(MotionValues.markMiddleScale), gather: MotionValues.markGather, part: MotionValues.markPart),
        MarkDot(restX: CGFloat(MotionValues.markSpread), gatheredX: 1, gatheredScale: CGFloat(MotionValues.markSideScale), gather: MotionValues.markLagGather, part: MotionValues.markLagPart),
    ]
    /// A dot of the mark, in points.
    static let markDot: CGFloat = 3

    /// A loop as the animation Core Animation repeats for good on a layer's
    /// `keyPath`: the render server draws every frame of it, and none runs
    /// on the main thread. A layer loses its animations when it leaves its
    /// window; the view that owns it adds them again when it comes back.
    static func repeating(_ loop: MotionLoop, keyPath: String) -> CAKeyframeAnimation {
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        animation.values = loop.values
        animation.keyTimes = loop.keyTimes.map { NSNumber(value: $0) }
        animation.timingFunctions = loop.legs.map { leg in
            leg.curve.map { CAMediaTimingFunction(controlPoints: Float($0.x1), Float($0.y1), Float($0.x2), Float($0.y2)) } ?? CAMediaTimingFunction(name: .linear)
        }
        animation.duration = loop.period
        animation.repeatCount = .infinity
        animation.isRemovedOnCompletion = false
        return animation
    }

    // MARK: A glyph trading state

    /// Send ↔ Stop, outline ↔ fill, pin ↔ unpin: the new glyph grows from a
    /// quarter of its size, fading and unblurring, on a spring with no
    /// bounce. Under reduced motion it cross-fades on `iconFade`.
    static let iconSwap: Animation = .spring(duration: MotionValues.iconSwap, bounce: 0)
    static let iconSwapScale: CGFloat = 0.25
    static let iconSwapBlur: CGFloat = 4
    /// The cross-fade for the reduced-motion icon path, on the swap curve.
    static let iconFade: Animation = curve(MotionValues.easeSwap, MotionValues.fast)

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

    /// A glyph trading state: scale, opacity and blur on `iconSwap`; a plain
    /// cross-fade on `iconFade` under reduced motion. Pair it with `.id(name)`
    /// on the glyph inside a `ZStack`, or use `.iconSwapTransition()`.
    static func iconSwap(reduced: Bool) -> AnyTransition {
        reduced
            ? .opacity.animation(iconFade)
            : .modifier(
                active: IconSwap(scale: iconSwapScale, blur: iconSwapBlur, opacity: 0),
                identity: IconSwap(scale: 1, blur: 0, opacity: 1)
            ).animation(iconSwap)
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

    private struct IconSwap: ViewModifier {
        let scale: CGFloat
        let blur: CGFloat
        let opacity: Double

        func body(content: Content) -> some View {
            content.scaleEffect(scale).blur(radius: blur).opacity(opacity)
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

    /// `Motion.iconSwap`, reading reduced motion itself. Pair it with
    /// `.id(systemName)` on the glyph inside a `ZStack`.
    func iconSwapTransition() -> some View {
        modifier(MotionTransition(kind: .iconSwap))
    }
}

private struct MotionTransition: ViewModifier {
    enum Kind {
        case appear
        case swap
        case jump
        case iconSwap
    }

    let kind: Kind
    @Environment(\.accessibilityReduceMotion) private var reduced

    func body(content: Content) -> some View {
        switch kind {
        case .appear: content.transition(Motion.appear(reduced: reduced))
        case .swap: content.transition(Motion.swap(reduced: reduced))
        case .jump: content.transition(Motion.jump(reduced: reduced))
        case .iconSwap: content.transition(Motion.iconSwap(reduced: reduced))
        }
    }
}
