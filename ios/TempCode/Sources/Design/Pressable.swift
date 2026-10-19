import SwiftUI

/// Press feedback on every row and button: scale 0.96 in 160 ms ease-out from
/// the touch down, back the same way on release. Touch has no hover state.
/// Reduced motion dims instead of scaling. The label keeps its own colors.
struct PressableStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .scaleEffect(configuration.isPressed && !reduceMotion ? Motion.pressScale : 1)
            .opacity(configuration.isPressed && reduceMotion ? 0.6 : 1)
            .animation(Motion.press, value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PressableStyle {
    static var pressable: PressableStyle { PressableStyle() }
}
