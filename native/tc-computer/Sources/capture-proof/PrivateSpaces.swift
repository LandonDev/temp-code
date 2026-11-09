// PROOF ONLY. This file calls SkyLight's PRIVATE window-server API to move the proof's own test
// window to another Space, so scene 6 can show that Capture reads a window on a Space the person
// is not looking at. It must never be linked into tc-computer or any target that ships: every
// symbol is looked up at run time with dlopen/dlsym, nothing private is linked, and the
// PrivateCallScanTests fail on SLS, CGS, dlopen or dlsym in any target but capture-proof. It moves
// only the window whose number it is given (the proof's own), and a missing symbol skips the scene.

#if canImport(ScreenCaptureKit)

import CoreFoundation
import Darwin
import Foundation

enum PrivateSpaces {
    fileprivate typealias MainConnectionID = @convention(c) () -> Int32
    fileprivate typealias CopyManagedDisplaySpaces = @convention(c) (Int32) -> Unmanaged<CFArray>?
    fileprivate typealias ChangeWindowSpaces = @convention(c) (Int32, CFArray, CFArray) -> Void
    fileprivate typealias CopySpacesForWindows = @convention(c) (Int32, Int32, CFArray) -> Unmanaged<CFArray>?

    struct Api {
        fileprivate let connection: Int32
        fileprivate let copyDisplaySpaces: CopyManagedDisplaySpaces
        fileprivate let add: ChangeWindowSpaces
        fileprivate let remove: ChangeWindowSpaces
        fileprivate let spacesForWindows: CopySpacesForWindows
    }

    struct Space: Equatable {
        let id: Int
        let type: Int
        let display: String
    }

    /// The calls, or the reason they are not there.
    static func load() -> Result<Api, ProofError> {
        guard let handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY) else {
            return .failure(ProofError("SkyLight did not open"))
        }
        func symbol<T>(_ name: String, as _: T.Type) -> T? {
            dlsym(handle, name).map { unsafeBitCast($0, to: T.self) }
        }
        guard let main = symbol("SLSMainConnectionID", as: MainConnectionID.self) else { return .failure(ProofError("SLSMainConnectionID is missing")) }
        guard let copy = symbol("SLSCopyManagedDisplaySpaces", as: CopyManagedDisplaySpaces.self) else { return .failure(ProofError("SLSCopyManagedDisplaySpaces is missing")) }
        guard let add = symbol("SLSAddWindowsToSpaces", as: ChangeWindowSpaces.self) else { return .failure(ProofError("SLSAddWindowsToSpaces is missing")) }
        guard let remove = symbol("SLSRemoveWindowsFromSpaces", as: ChangeWindowSpaces.self) else { return .failure(ProofError("SLSRemoveWindowsFromSpaces is missing")) }
        guard let spaces = symbol("SLSCopySpacesForWindows", as: CopySpacesForWindows.self) else { return .failure(ProofError("SLSCopySpacesForWindows is missing")) }
        return .success(Api(connection: main(), copyDisplaySpaces: copy, add: add, remove: remove, spacesForWindows: spaces))
    }

    /// Every display's Spaces and its current one.
    static func displays(_ api: Api) -> [(display: String, current: Int, spaces: [Space])] {
        guard let list = api.copyDisplaySpaces(api.connection)?.takeRetainedValue() as? [[String: Any]] else { return [] }
        return list.compactMap { entry in
            let display = entry["Display Identifier"] as? String ?? "?"
            guard let current = (entry["Current Space"] as? [String: Any]).flatMap(spaceID) else { return nil }
            let spaces = (entry["Spaces"] as? [[String: Any]] ?? []).compactMap { space -> Space? in
                guard let id = spaceID(space) else { return nil }
                return Space(id: id, type: (space["type"] as? NSNumber)?.intValue ?? -1, display: display)
            }
            return (display, current, spaces)
        }
    }

    /// The Spaces a window is on.
    static func spaces(of window: Int, _ api: Api) -> [Int] {
        let windows = [NSNumber(value: window)] as CFArray
        guard let list = api.spacesForWindows(api.connection, 0x7, windows)?.takeRetainedValue() as? [NSNumber] else { return [] }
        return list.map(\.intValue)
    }

    /// Moves the proof's own window from one Space to another.
    static func move(window: Int, from: Int, to: Int, _ api: Api) {
        let windows = [NSNumber(value: window)] as CFArray
        api.add(api.connection, windows, [NSNumber(value: to)] as CFArray)
        api.remove(api.connection, windows, [NSNumber(value: from)] as CFArray)
    }

    private static func spaceID(_ space: [String: Any]) -> Int? {
        (space["ManagedSpaceID"] as? NSNumber)?.intValue ?? (space["id64"] as? NSNumber)?.intValue
    }
}

#endif
