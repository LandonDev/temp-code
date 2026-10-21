import SwiftUI

/// Press feedback on every row and button: scale 0.96 in 160 ms ease-out from
/// the touch down, back the same way on release, interruptible either way.
/// Touch has no hover state, so the pointer's hover effect is off too.
/// Reduced motion dims instead of scaling. The label keeps its own colors.
struct PressableStyle: ButtonStyle {
    /// Off where the scale would distract (a control inside a scrolling text
    /// block, a glyph in a dense toolbar): the press dims instead.
    var scales = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        let scaling = scales && !reduceMotion
        configuration.label
            .contentShape(Rectangle())
            .scaleEffect(pressed && scaling ? Motion.pressScale : 1)
            .opacity(pressed && !scaling ? Motion.pressDim : 1)
            .animation(Motion.press, value: pressed)
            .hoverEffectDisabled()
    }
}

extension ButtonStyle where Self == PressableStyle {
    /// The press every row and button uses.
    static var pressable: PressableStyle { PressableStyle() }
    /// The same press without the scale: a dim only.
    static var pressableStatic: PressableStyle { PressableStyle(scales: false) }
}

/// A small action inside a row (Retry, Pair again, Continue): a capsule on
/// the fill step, or filled with a tint and white text when it is the one
/// thing to do, with the same press feedback as everything else. A glyph
/// sits 2 pt closer to its edge than the text does to the other, so the
/// pair reads centered.
struct PillButton: View {
    let title: String
    var systemImage: String?
    var tint: Color?
    let action: () -> Void

    init(_ title: String, systemImage: String? = nil, tint: Color? = nil, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = systemImage
        self.tint = tint
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.footnote.weight(.medium))
                        .imageScale(.small)
                }
                Text(title)
                    .font(.footnote.weight(.medium))
            }
            .padding(.leading, systemImage == nil ? 12 : 10)
            .padding(.trailing, 12)
            .padding(.vertical, 6)
            .foregroundStyle(tint == nil ? AnyShapeStyle(.primary) : AnyShapeStyle(.white))
            .background(tint ?? Surface.fill, in: Capsule())
        }
        .buttonStyle(.pressable)
    }
}
