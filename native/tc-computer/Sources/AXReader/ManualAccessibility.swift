#if canImport(ApplicationServices)
import AppKit
import ApplicationServices
import AXText
import Foundation

extension ManualAccessibility {
    /// The live setter: AXManualAccessibility on the app element, which
    /// Electron answers and a native app refuses with -25205. An app bundle
    /// holding Electron's framework counts as Chromium whatever the answer: the
    /// set takes effect with a delay and reads back false. AXEnhancedUserInterface
    /// is never set: it disturbs window animation.
    static func live() -> ManualAccessibility {
        ManualAccessibility(
            set: { pid in
                let took = AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
                return took || electron(pid)
            },
            clock: { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }
        )
    }

    static func electron(_ pid: pid_t) -> Bool {
        guard let bundle = NSRunningApplication(processIdentifier: pid)?.bundleURL else { return false }
        return FileManager.default.fileExists(atPath: bundle.appendingPathComponent("Contents/Frameworks/Electron Framework.framework").path)
    }
}
#endif
