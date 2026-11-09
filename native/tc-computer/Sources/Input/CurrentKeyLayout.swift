import Carbon
import Foundation

/// Runs `work` on the main thread and waits for it at most `InputTiming.mainHopS`; nil when
/// main did not answer in time. Input's calls run off main; the watch and TIS need main.
func onMain<T: Sendable>(_ work: @escaping @Sendable @MainActor () -> T) -> T? {
    if Thread.isMainThread { return MainActor.assumeIsolated { work() } }
    let box = MainResult<T>()
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
        box.value = MainActor.assumeIsolated { work() }
        done.signal()
    }
    return done.wait(timeout: .now() + InputTiming.mainHopS) == .success ? box.value : nil
}

private final class MainResult<T>: @unchecked Sendable {
    var value: T?
}

/// The person's keyboard layout: each character a key code and modifiers types, read through
/// TIS and UCKeyTranslate on main at first use and again when the input source changes. A
/// source with no layout data (some input methods) falls back to US ANSI, said once.
public final class CurrentKeyLayout: KeyLayoutSource, @unchecked Sendable {
    public static let shared = CurrentKeyLayout()

    private let lock = NSLock()
    private var map: [Character: KeyStroke]?
    private var fallback = false
    private var observing = false

    public init() {}

    public func stroke(for c: Character) -> KeyStroke? {
        let (strokes, usFallback) = current()
        if usFallback { return USANSILayout().stroke(for: c) }
        return strokes[c]
    }

    /// How many characters the layout types, for the test that it built on this Mac.
    public var count: Int { current().0.count }

    private func current() -> ([Character: KeyStroke], Bool) {
        if let m = lock.withLock({ map }) { return (m, lock.withLock { fallback }) }
        let built = onMain { CurrentKeyLayout.build() } ?? nil
        lock.withLock {
            map = built ?? [:]
            fallback = built == nil
        }
        if built == nil { FileHandle.standardError.write(Data("[input] the keyboard layout has no key data; typing keys as US ANSI\n".utf8)) }
        observe()
        return (built ?? [:], built == nil)
    }

    private func observe() {
        guard !lock.withLock({ let was = observing; observing = true; return was }) else { return }
        let name = Notification.Name(kTISNotifySelectedKeyboardInputSourceChanged as String)
        DistributedNotificationCenter.default().addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
            self?.lock.withLock { self?.map = nil }
        }
    }

    /// Codes the keypad and the function row use: never a character's key.
    private static let skipped: Set<UInt16> = [65, 67, 69, 71, 75, 76, 78, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92]

    /// The layout's map, fewest modifiers first; nil when the source has no `uchr` data.
    @MainActor
    static func build() -> [Character: KeyStroke]? {
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        let kbdType = UInt32(LMGetKbdType())
        // modifier states as UCKeyTranslate takes them: (EventModifiers >> 8) & 0xFF
        let states: [(UInt32, Modifiers)] = [(0, []), (UInt32(shiftKey >> 8), .shift), (UInt32(optionKey >> 8), .option), (UInt32((shiftKey | optionKey) >> 8), [.shift, .option])]
        var map: [Character: KeyStroke] = [:]
        data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            guard let layout = buf.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
            for (state, mods) in states {
                for code in UInt16(0) ..< 128 where !skipped.contains(code) {
                    var dead: UInt32 = 0
                    var length = 0
                    var chars = [UniChar](repeating: 0, count: 4)
                    let status = UCKeyTranslate(layout, code, UInt16(kUCKeyActionDown), state, kbdType, OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &length, &chars)
                    guard status == noErr, length > 0 else { continue }
                    let s = String(utf16CodeUnits: chars, count: length)
                    guard s.count == 1, let c = s.first, !c.isNewline, c != "\t", !(c.unicodeScalars.first!.properties.generalCategory == .control) else { continue }
                    if map[c] == nil { map[c] = KeyStroke(code: code, modifiers: mods) }
                }
            }
        }
        return map
    }
}
