import ComputerCore
import ComputerProtocol

public enum MouseButton: Sendable, Equatable {
    case left, right, middle
}

public enum ScrollAxis: Sendable, Equatable {
    /// wheel 1
    case vertical
    /// wheel 2
    case horizontal
}

/// One event Input will post, or a pause between them; EventMaker turns it into a CGEvent.
public enum SyntheticEvent: Equatable, Sendable {
    case move(ScreenPoint, dragging: MouseButton?)
    case down(MouseButton, ScreenPoint, clickState: Int, flags: Modifiers)
    case up(MouseButton, ScreenPoint, clickState: Int, flags: Modifiers)
    /// one line unit, ±1
    case scroll(lines: Int32, axis: ScrollAxis, at: ScreenPoint, flags: Modifiers)
    /// a modifier key's own down or up (flagsChanged), with the flags after it
    case modifier(UInt16, down: Bool, flags: Modifiers)
    case key(UInt16, down: Bool, flags: Modifiers)
    /// a Unicode keyboard event: virtual key 0 with this string
    case unicode(String, down: Bool)
    case pause(ms: Int)

    /// Whether this event goes out (a pause does not).
    public var posts: Bool {
        if case .pause = self { false } else { true }
    }
}

/// Plans of synthetic events for each kind of input, pure: the tiers post them.
public enum EventPlans {
    /// The modifier key-downs, the flags cumulative, in print order.
    static func modifierDowns(_ m: Modifiers) -> [SyntheticEvent] {
        var flags: Modifiers = []
        return m.each.map { one in
            flags.insert(one)
            return .modifier(KeyCodes.modifierCodes[name(of: one)]!, down: true, flags: flags)
        }
    }

    /// The modifier key-ups, in reverse.
    static func modifierUps(_ m: Modifiers) -> [SyntheticEvent] {
        var flags = m
        return m.each.reversed().map { one in
            flags.remove(one)
            return .modifier(KeyCodes.modifierCodes[name(of: one)]!, down: false, flags: flags)
        }
    }

    private static func name(of one: Modifiers) -> String {
        Modifiers.canonical.first { $0.0 == one }!.1
    }

    /// A click of `count` presses: an optional move first, then down, a hold, up, the multi-click gap between pairs.
    public static func click(_ b: MouseButton, at p: ScreenPoint, count: Int, modifiers: Modifiers, holdMs: Int?, moveFirst: Bool) -> [SyntheticEvent] {
        var out: [SyntheticEvent] = []
        if moveFirst { out += [.move(p, dragging: nil), .pause(ms: InputTiming.moveSettleMs)] }
        out += modifierDowns(modifiers)
        for n in 1 ... max(1, count) {
            out.append(.down(b, p, clickState: n, flags: modifiers))
            out.append(.pause(ms: holdMs ?? InputTiming.clickHoldMs))
            out.append(.up(b, p, clickState: n, flags: modifiers))
            if n < count { out.append(.pause(ms: InputTiming.multiClickGapMs)) }
        }
        return out + modifierUps(modifiers)
    }

    /// The moves of a drag from `a` to `b` with the left button down: `dragSteps` points on a straight line, the last on `b`.
    public static func dragPath(from a: ScreenPoint, to b: ScreenPoint) -> [ScreenPoint] {
        let n = InputTiming.dragSteps
        return (1 ... n).map { i in
            let t = Double(i) / Double(n)
            return ScreenPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
        }
    }

    /// A drag: down at the start, the path's moves over `dragMs`, up at the end.
    public static func drag(from a: ScreenPoint, to b: ScreenPoint, modifiers: Modifiers) -> [SyntheticEvent] {
        let gap = InputTiming.dragMs / InputTiming.dragSteps
        var out = modifierDowns(modifiers)
        out.append(.down(.left, a, clickState: 1, flags: modifiers))
        for p in dragPath(from: a, to: b) { out += [.pause(ms: gap), .move(p, dragging: .left)] }
        out.append(.up(.left, b, clickState: 1, flags: modifiers))
        return out + modifierUps(modifiers)
    }

    /// One line-unit wheel event per click: `up` is wheel 1 +1, `down` −1, `left` wheel 2 +1, `right` −1.
    public static func scroll(_ d: ScrollDirection, clicks: Int, at p: ScreenPoint, modifiers: Modifiers) -> [SyntheticEvent] {
        let (lines, axis): (Int32, ScrollAxis) = switch d {
        case .up: (1, .vertical)
        case .down: (-1, .vertical)
        case .left: (1, .horizontal)
        default: (-1, .horizontal)
        }
        var out = modifierDowns(modifiers)
        for i in 0 ..< max(1, clicks) {
            if i > 0 { out.append(.pause(ms: InputTiming.scrollGapMs)) }
            out.append(.scroll(lines: lines, axis: axis, at: p, flags: modifiers))
        }
        return out + modifierUps(modifiers)
    }

    /// How a combo's key goes down: a virtual key with the modifiers the layout adds, a modifier key of its own, or a Unicode string.
    enum KeyPress: Equatable {
        case key(UInt16, adds: Modifiers)
        case modifier(Modifiers)
        case unicode(String)
    }

    static func press(_ c: KeyCombo, layout: KeyLayoutSource) throws -> KeyPress {
        switch c.key {
        case .named(let name):
            if let m = Modifiers(canonical: name) { return .modifier(m) }
            if let code = KeyCodes.code(name) { return .key(code, adds: []) }
            if let ch = KeyCodes.character(name) { return try character(ch, combo: c, layout: layout) }
            throw ComputerFailure(.invalidKey, "\"\(name)\" is not a key")
        case .character(let ch):
            return try character(ch, combo: c, layout: layout)
        }
    }

    private static func character(_ ch: Character, combo: KeyCombo, layout: KeyLayoutSource) throws -> KeyPress {
        if let s = layout.stroke(for: ch) { return .key(s.code, adds: s.modifiers) }
        if combo.modifiers.isEmpty { return .unicode(String(ch)) }
        throw ComputerFailure(.invalidKey, "no key on this keyboard layout types ‘\(ch)’")
    }

    /// A combo pressed `repeat` times: the modifier downs, the key down and up each time with the flags, the modifier ups.
    public static func chord(_ c: KeyCombo, layout: KeyLayoutSource, repeat count: Int) throws -> [SyntheticEvent] {
        let press = try press(c, layout: layout)
        let n = max(1, count)
        switch press {
        case .key(let code, let adds):
            let flags = c.modifiers.union(adds)
            var out = modifierDowns(flags)
            for _ in 0 ..< n { out += [.key(code, down: true, flags: flags), .key(code, down: false, flags: flags)] }
            return out + modifierUps(flags)
        case .modifier(let m):
            var out = modifierDowns(c.modifiers)
            let code = KeyCodes.modifierCodes[name(of: m)]!
            for _ in 0 ..< n {
                out += [.modifier(code, down: true, flags: c.modifiers.union(m)), .modifier(code, down: false, flags: c.modifiers)]
            }
            return out + modifierUps(c.modifiers)
        case .unicode(let s):
            return (0 ..< n).flatMap { _ in [SyntheticEvent.unicode(s, down: true), .unicode(s, down: false)] }
        }
    }

    /// A combo held: its downs now, its ups later. A Unicode key cannot be held down.
    public static func hold(_ c: KeyCombo, layout: KeyLayoutSource) throws -> (downs: [SyntheticEvent], ups: [SyntheticEvent]) {
        switch try press(c, layout: layout) {
        case .key(let code, let adds):
            let flags = c.modifiers.union(adds)
            return (modifierDowns(flags) + [.key(code, down: true, flags: flags)], [.key(code, down: false, flags: flags)] + modifierUps(flags))
        case .modifier(let m):
            let all = c.modifiers.union(m)
            return (modifierDowns(all), modifierUps(all))
        case .unicode(let s):
            throw ComputerFailure(.invalidKey, "‘\(s)’ has no key on this keyboard layout to hold")
        }
    }

    /// Text as Unicode key events: chunks of at most `typeChunkUnits` UTF-16 units, never cut inside a
    /// grapheme cluster; a line break (`\n`, `\r\n`, `\r`) is Return and `\t` is Tab, as real keys.
    public static func typing(_ text: String) -> [SyntheticEvent] {
        var out: [SyntheticEvent] = []
        var chunk = ""
        func gap() { if !out.isEmpty { out.append(.pause(ms: InputTiming.typeChunkGapMs)) } }
        func flush() {
            guard !chunk.isEmpty else { return }
            gap()
            out += [.unicode(chunk, down: true), .unicode(chunk, down: false)]
            chunk = ""
        }
        for ch in text {
            let code: UInt16? = switch ch {
            case "\n", "\r\n", "\r": KeyCodes.returnKey
            case "\t": KeyCodes.tab
            default: nil
            }
            if let code {
                flush()
                gap()
                out += [.key(code, down: true, flags: []), .key(code, down: false, flags: [])]
                continue
            }
            if chunk.utf16.count + ch.utf16.count > InputTiming.typeChunkUnits { flush() }
            chunk.append(ch)
        }
        flush()
        return out
    }
}
