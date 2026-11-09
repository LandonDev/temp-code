#if canImport(ScreenCaptureKit)

import CoreGraphics
import Foundation

/// A window's live bounds by CGWindowID, read from the window server on every call.
public enum LiveWindows {
    /// The window's frame in global points, top-left origin: the space AX frames use. It may be
    /// negative or past the main display and is never clamped. Nil when the window is gone.
    public static func bounds(_ windowID: UInt32) -> CGRect? {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(windowID)) as? [[String: Any]],
              let info = list.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID }),
              let dictionary = info[kCGWindowBounds as String] as? NSDictionary
        else { return nil }
        return CGRect(dictionaryRepresentation: dictionary as CFDictionary)
    }
}

#endif
