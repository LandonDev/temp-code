import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// The one way a product target reaches a private function (docs/computer-protocol.md §11, shell A10).
/// A private symbol is allowed only when it is read-only, resolved by name here at run time (so a
/// macOS that drops it degrades instead of failing to load), has a public fallback a unit test
/// exercises by forcing the miss, and has a row in native/tc-computer/README.md "Private symbols".
/// `dlsym` appears in this file and nowhere else; scripts/tc-computer-guard.test.ts holds it so.
public enum PrivateSymbol {
    /// Names that must miss: "all", or a comma list. Read once from `TC_COMPUTER_PRIVATE_MISS`; tests set it directly.
    nonisolated(unsafe) public static var forcedMisses: Set<String> = misses(ProcessInfo.processInfo.environment["TC_COMPUTER_PRIVATE_MISS"])

    /// `dlsym(RTLD_DEFAULT, name)` cast to `T` (a `@convention(c)` function type); nil when the
    /// symbol is missing, forced to miss, or `T` is not pointer-sized.
    public static func lookup<T>(_ name: String, as type: T.Type) -> T? {
        if forcedMisses.contains("all") || forcedMisses.contains(name) { return nil }
        guard MemoryLayout<T>.size == MemoryLayout<UnsafeRawPointer>.size, let raw = dlsym(defaultHandle, name) else { return nil }
        return unsafeBitCast(raw, to: type)
    }

    /// The miss list `TC_COMPUTER_PRIVATE_MISS` names.
    public static func misses(_ value: String?) -> Set<String> {
        Set((value ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
    }

    #if canImport(Darwin)
    /// RTLD_DEFAULT, `((void *) -2)` on Darwin, which Swift does not import.
    private static let defaultHandle = UnsafeMutableRawPointer(bitPattern: -2)
    #else
    private static let defaultHandle: UnsafeMutableRawPointer? = nil
    #endif
}
