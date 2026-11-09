#if canImport(ApplicationServices)
import ApplicationServices
import AXText
import Foundation

extension ManualAccessibility {
    /// The live setter: AXManualAccessibility on the app element, which
    /// Chromium and Electron answer and a native app refuses with -25205.
    /// AXEnhancedUserInterface is never set: it disturbs window animation.
    static func live() -> ManualAccessibility {
        ManualAccessibility(
            set: { pid in AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success },
            clock: { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }
        )
    }
}
#endif
