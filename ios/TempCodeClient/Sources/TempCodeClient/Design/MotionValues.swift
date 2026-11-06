import Foundation

/// The desktop's motion numbers, exactly: durations from index.css's
/// `--dur-*`, curves and springs from lib/ease.ts, the holds from
/// lib/heldWord.ts, lib/foldHold.ts, lib/clipboard.ts and shared/watch.ts.
/// scripts/ios-motion-parity.test.ts reads this file and fails when one
/// differs, so write each value on its own `static let` line. The app's
/// `Motion` (Design/Motion.swift) turns them into SwiftUI animations; no
/// view writes a duration, a curve or a spring itself.
public enum MotionValues {
    /// A cubic Bézier as CSS writes it: `cubic-bezier(x1, y1, x2, y2)`.
    public struct Curve: Sendable, Equatable {
        public let x1: Double
        public let y1: Double
        public let x2: Double
        public let y2: Double

        public init(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) {
            self.x1 = x1
            self.y1 = y1
            self.x2 = x2
            self.y2 = y2
        }

        /// The eased progress at `t` in [0, 1] (Newton on x, then bisection),
        /// the desktop's `cubicBezier`.
        public func value(at t: Double) -> Double {
            if t <= 0 { return 0 }
            if t >= 1 { return 1 }
            func at(_ a: Double, _ b: Double, _ s: Double) -> Double {
                ((1 - 3 * b + 3 * a) * s + (3 * b - 6 * a)) * s * s + 3 * a * s
            }
            func slope(_ a: Double, _ b: Double, _ s: Double) -> Double {
                3 * (1 - 3 * b + 3 * a) * s * s + 2 * (3 * b - 6 * a) * s + 3 * a
            }
            var s = t
            for _ in 0..<8 {
                let dx = at(x1, x2, s) - t
                if abs(dx) < 1e-6 { return at(y1, y2, s) }
                let d = slope(x1, x2, s)
                if abs(d) < 1e-6 { break }
                s -= dx / d
            }
            var lo = 0.0
            var hi = 1.0
            s = t
            while hi - lo > 1e-6 {
                if at(x1, x2, s) < t { lo = s } else { hi = s }
                s = (lo + hi) / 2
            }
            return at(y1, y2, s)
        }
    }

    /// A mass-spring as the desktop's Motion springs write it.
    public struct Spring: Sendable, Equatable {
        public let stiffness: Double
        public let damping: Double
        public let mass: Double

        public init(stiffness: Double, damping: Double, mass: Double) {
            self.stiffness = stiffness
            self.damping = damping
            self.mass = mass
        }

        /// The first instant after which the step response stays within
        /// `rest` of 1, rounded up to 10 ms: the desktop's `springEasing` ms.
        public func settleSeconds(rest: Double = 0.005) -> Double {
            var x = 0.0
            var v = 0.0
            var settled = 0
            for t in 1...5000 {
                v += ((-stiffness * (x - 1) - damping * v) / mass) * 0.001
                x += v * 0.001
                if abs(1 - x) >= rest { settled = t }
            }
            return (Double(settled + 1) / 10).rounded(.up) * 10 / 1000
        }
    }

    // MARK: Durations, seconds (index.css)

    /// `--dur-swap-out`: the old words of a morph leaving.
    public static let swapOut: Double = 0.09
    /// `--dur-fast`: a fade, a first appearance, a hidden control returning.
    public static let fast: Double = 0.12
    /// `--dur-base`: a step landing, a chevron turning, a morph arriving.
    public static let base: Double = 0.18
    /// `--dur-slow`: a newly sent bubble rising.
    public static let slow: Double = 0.24
    /// `--dur-drawer`: a drawer or sheet from an edge.
    public static let drawer: Double = 0.3
    /// `--dur-layout`: what `springLayout` settles in.
    public static let layout: Double = 0.37

    // MARK: Curves (lib/ease.ts, index.css)

    /// `EASE_OUT`, `--ease-out`.
    public static let easeOut = Curve(0.16, 1, 0.3, 1)
    /// `EASE_IN_OUT`, `--ease-in-out`.
    public static let easeInOut = Curve(0.77, 0, 0.175, 1)
    /// `EASE_DRAWER`, `--ease-drawer`.
    public static let easeDrawer = Curve(0.32, 0.72, 0, 1)
    /// `EASE_EXIT`, `--ease-exit`.
    public static let easeExit = Curve(0.4, 0, 0.6, 1)
    /// `EASE_SWAP`, `--ease-swap`: the word morph and its width glide.
    public static let easeSwap = Curve(0.2, 0, 0, 1)
    /// `--ease-breathe`: the working mark's segments.
    public static let easeBreathe = Curve(0.37, 0, 0.63, 1)
    /// The shimmer band's sweep.
    public static let shimmerSweep = Curve(0.714, 0.121, 0.211, 0.888)

    // MARK: Springs (lib/ease.ts)

    /// `SPRING_LAYOUT`: a row gliding into place, a fold opening.
    public static let springLayout = Spring(stiffness: 360, damping: 32, mass: 0.6)
    /// `SPRING_GLIDE`: a released drag settling.
    public static let springGlide = Spring(stiffness: 700, damping: 50, mass: 0.5)

    // MARK: The stream (REVEAL, --dur-reveal)

    /// A step of whole words about this often.
    public static let revealStep: Double = 0.1
    /// Each step fading in, linear.
    public static let revealFade: Double = 0.4
    /// A token longer than this many UTF-16 units is cut where the pace reaches.
    public static let longToken: Int = 24
    /// An open fence's unfinished code line is held this long, then steps by words.
    public static let revealLineHold: Double = 0.6

    // MARK: Holds

    /// `WORD_HOLD_MS`: a painted phase stays at least this long.
    public static let wordHold: Double = 0.3
    /// `FOLD_HOLD_MS`: a working group holds open after its work moved on.
    public static let foldHold: Double = 0.6
    /// `COPIED_MS`: a Copy's check.
    public static let copied: Double = 1.2
    /// `STALE_WATCH_MS`: a watch past this reads amber.
    public static let staleWatch: Double = 1800

    // MARK: Loops (SHIMMER, MARK, SPINNER_TURN)

    /// The shimmer's period: the band crosses once per period.
    public static let shimmerPeriod: Double = 3
    /// The band rests off the words until this share of the period…
    public static let shimmerStart: Double = 0.15
    /// …and has crossed them by this share.
    public static let shimmerEnd: Double = 0.85
    /// The working mark's three dots gather and part once per period.
    public static let markPeriod: Double = 1.6
    /// The side dots' rest, in points either side of the middle.
    public static let markSpread: Double = 4.5
    /// The side dots' scale while gathered.
    public static let markSideScale: Double = 0.8
    /// The middle dot's scale while gathered.
    public static let markMiddleScale: Double = 1.7
    /// The left and middle dots gather at this share of the period…
    public static let markGather: Double = 0.42
    /// …and part again at this share.
    public static let markPart: Double = 0.58
    /// The right dot runs behind: it gathers here…
    public static let markLagGather: Double = 0.5
    /// …and parts here.
    public static let markLagPart: Double = 0.66
    /// The spinner's turn.
    public static let spinnerTurn: Double = 0.9

    // MARK: The phone's own (touch has no desktop counterpart)

    /// Press on a button: the scale, from the touch down.
    public static let pressScale: Double = 0.96
    /// The press's duration on `easeOut`.
    public static let press: Double = 0.16
    /// Under reduced motion a pressed control dims to this instead.
    public static let pressDim: Double = 0.6
    /// A glyph trading state: a spring of this duration with no bounce.
    public static let iconSwap: Double = 0.3
}
