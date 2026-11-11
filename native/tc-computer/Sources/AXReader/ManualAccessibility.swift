#if canImport(ApplicationServices)
import AppKit
import ApplicationServices
import AXText
import Foundation

extension ManualAccessibility {
    /// The live machine: AXManualAccessibility set once per pid on the app element, for Electron (which
    /// answers it; Chrome refuses it with -25205, M1), and the process's kind from its bundle's
    /// `Contents/Frameworks`, read once (`LiveBundles`, §25.1). AXEnhancedUserInterface is never set:
    /// it changes how the app's windows animate and move for the person.
    static func live() -> ManualAccessibility {
        ManualAccessibility(
            set: { pid in AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success },
            kind: { LiveBundles.kind($0) },
            clock: { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }
        )
    }
}
#endif
