import Foundation
import TempCodeContract

/// What the live turn's working line says, the desktop's `workingPhase`
/// (surfaces/transcript/workingPhase.ts). `key` decides when the words
/// morph: a change of key morphs them (and is held at least
/// `MotionValues.wordHold`), new words under the same key (a count, a
/// seconds figure, a sentence growing) are drawn at once. A thought's
/// sentences are each a key of their own.
public struct LinePhase: Sendable, Hashable {
    public var key: String
    /// The words, plain; empty while prose streams (the mark alone).
    public var words: String
    /// What VoiceOver says when it is not `words`: a thought's sentences are said once as "Thinking".
    public var spoken: String?
    /// One call the line tells: its verb muted, its object in the primary step.
    public var verb: String?
    public var object: String?

    public init(key: String, words: String, spoken: String? = nil, verb: String? = nil, object: String? = nil) {
        self.key = key
        self.words = words
        self.spoken = spoken
        self.verb = verb
        self.object = object
    }

    public static let thinking = LinePhase(key: "thinking", words: "Thinking")

    /// First match wins: Sending while the person's message is not echoed;
    /// the host's word for the wait while nothing of the turn's own has come
    /// (keyed by its words up to the first comma); the wait on agents
    /// (`waitWords`); the running calls the line tells, one by its verb and
    /// object, several by the group's present-tense phrase; a thought
    /// streaming, as its newest finished sentence in Thinking's place; prose
    /// streaming, as the mark alone; else Thinking. `turn` is the open
    /// turn's entries, its user row first.
    public static func of(turn: [ThreadEntry], activity: String?, waitWords: String? = nil, cwd: String? = nil) -> LinePhase {
        let last = turn.last
        if let last, case .user(let user) = last.item, user.seq < 0 { return LinePhase(key: "sending", words: "Sending") }
        if !started(turn), let activity = activity?.trimmingCharacters(in: .whitespaces), !activity.isEmpty {
            let head = activity.split(separator: ",", maxSplits: 1).first.map(String.init) ?? activity
            return LinePhase(key: "host:\(head)", words: activity)
        }
        if let waitWords, !waitWords.isEmpty { return LinePhase(key: "wait", words: waitWords) }
        let calls = told(turn)
        if calls.count == 1 {
            let phrase = ToolPhrase.of(calls[0], live: true, cwd: cwd)
            return LinePhase(key: "call:\(calls[0].callId)", words: phrase.line, verb: phrase.verb, object: phrase.target)
        }
        if calls.count > 1 { return LinePhase(key: "calls", words: ToolPhrase.group(calls, cwd: cwd, live: true)) }
        if let thought = turn.last(where: { if case .thinking(let b) = $0.item { return b.streaming } else { return false } }),
           case .thinking(let block) = thought.item {
            let line = ThoughtLine.latest(block.text)
            if line.isEmpty { return .thinking }
            return LinePhase(key: "thought:\(ThoughtLine.latestKey(block.text))", words: line, spoken: "Thinking")
        }
        if let last, case .assistant(let block) = last.item, block.streaming { return LinePhase(key: "writing", words: "") }
        return .thinking
    }

    /// Something of the turn's own has come: anything but the person's row and an empty thought or reply.
    static func started(_ turn: [ThreadEntry]) -> Bool {
        turn.contains { entry in
            switch entry.item {
            case .user: false
            case .thinking(let block), .assistant(let block): !block.text.isEmpty
            default: true
            }
        }
    }

    /// `toldByWorkingLine`: a call still running that waits on nobody and is
    /// no agent work; the line says it until it settles into its row.
    public static func told(_ turn: [ThreadEntry]) -> [ToolItem] {
        let asking = Set(turn.compactMap { entry -> String? in
            if case .approval(let approval) = entry.item, approval.allowed == nil { return approval.request.toolName }
            return nil
        })
        return turn.compactMap { entry in
            guard case .tool(let tool) = entry.item, tool.status == .running, !tool.isPlanTool,
                  !asking.contains(tool.name), !isAgentWork(tool) else { return nil }
            return tool
        }
    }

    /// Agent work: spawning, waiting on, steering or checking a subagent, or the CLI's own Task/Agent.
    public static func isAgentWork(_ tool: ToolItem) -> Bool {
        let short = ToolPhrase.shortName(tool.name)
        return ["Task", "Agent", "spawn_agent", "wait_for_agent", "send_to_agent", "check_agent", "interrupt_agent", "answer_agent", "list_agents"].contains(short)
    }
}

/// A thought's sentences, the desktop's thinking.ts: the newest finished
/// one as plain text for the working line, its ordinal as the phase's key.
public enum ThoughtLine {
    public static let maxLength = 160

    /// "4s", "1m 12s", "2m": a span never shorter than one second.
    public static func spanWords(ms: Int) -> String {
        let total = max(1, Int((Double(ms) / 1_000).rounded()))
        if total < 60 { return "\(total)s" }
        let minutes = total / 60
        let seconds = total % 60
        return seconds == 0 ? "\(minutes)m" : "\(minutes)m \(seconds)s"
    }

    /// The newest finished sentence, plain, cut at 160 with "…"; the one
    /// being written only when it is all there is.
    public static func latest(_ text: String) -> String {
        let all = sentences(text)
        let index = latestIndex(all)
        guard index >= 0 else { return "" }
        let line = all[index]
        guard line.count > maxLength else { return line }
        return String(line.prefix(maxLength - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// The ordinal of the sentence `latest` shows; -1 for an empty thought.
    public static func latestKey(_ text: String) -> Int {
        latestIndex(sentences(text))
    }

    static func latestIndex(_ sentences: [String]) -> Int {
        guard !sentences.isEmpty else { return -1 }
        let last = sentences.count - 1
        return ends(sentences[last]) || last == 0 ? last : last - 1
    }

    private static func ends(_ sentence: String) -> Bool {
        guard let c = sentence.last else { return false }
        return ".!?:".contains(c)
    }

    static func sentences(_ text: String) -> [String] {
        let body = text.replacing(/```[\s\S]*?(?:```|$)/, with: "\n")
        let lines = body.split(separator: "\n", omittingEmptySubsequences: false).map { raw -> String in
            String(raw)
                .replacing(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/, with: "")
                .replacing(/`([^`]*)`/) { String($0.1) }
                .replacing(/!?\[([^\]]*)\]\([^)]*\)/) { String($0.1) }
                .replacing(/\*\*(.+?)\*\*/) { String($0.1) }
                .replacing(/__(.+?)__/) { String($0.1) }
                .replacing(/\*(.+?)\*/) { String($0.1) }
                .replacing(/_(.+?)_/) { String($0.1) }
                .trimmingCharacters(in: .whitespaces)
        }.filter { !$0.isEmpty }
        return lines.flatMap { line -> [String] in
            var out: [String] = []
            var current = ""
            let chars = Array(line)
            var i = 0
            while i < chars.count {
                current.append(chars[i])
                if ".!?:".contains(chars[i]), i + 1 < chars.count, chars[i + 1].isWhitespace {
                    out.append(current)
                    current = ""
                    while i + 1 < chars.count, chars[i + 1].isWhitespace { i += 1 }
                }
                i += 1
            }
            if !current.isEmpty { out.append(current) }
            return out
        }
    }
}

/// `useHeldPhase` without React: a phase that painted stays at least `hold`
/// (seconds); one that came and went inside the hold never paints; while
/// the shown key is the current one, the current phase shows at once with
/// its new words. A closing state goes through the same hold. Time is the
/// caller's clock in seconds.
public struct HeldPhase: Sendable, Hashable {
    public private(set) var shown: LinePhase
    /// When `shown`'s key painted.
    public private(set) var paintedAt: Double
    public let hold: Double

    public init(_ phase: LinePhase, at now: Double, hold: Double = MotionValues.wordHold) {
        shown = phase
        paintedAt = now
        self.hold = hold
    }

    /// The phase to draw for `phase` at `now`; `due` is when to ask again
    /// (nil when nothing is waiting on the hold).
    public mutating func update(_ phase: LinePhase, at now: Double) -> (shown: LinePhase, due: Double?) {
        if phase.key == shown.key {
            shown = phase
            return (shown, nil)
        }
        let ready = paintedAt + hold
        if now >= ready {
            shown = phase
            paintedAt = now
            return (shown, nil)
        }
        return (shown, ready)
    }
}

/// The word morph, the desktop's `MorphText` as a sequence: the old words
/// lift 3 pt and fade over `swapOut`, then the new rise 3 pt and fade in
/// over `base` on the swap curve while the width glides over `base`, the
/// arriving words clipped and never ellipsized while it glides. Under
/// reduced motion the old fade out, then the new fade in, `fast` each, with
/// no lift. One set of words is on screen at a time.
public struct MorphModel: Sendable, Hashable {
    public enum Stage: Sendable, Hashable {
        /// The words rest.
        case still(String)
        /// The old words leave.
        case leaving(String, next: String)
        /// The new words arrive (the width gliding with them).
        case arriving(String)
    }

    public static let lift = 3.0

    public let reduced: Bool
    public private(set) var stage: Stage
    private var startedAt = 0.0

    public init(_ words: String, reduced: Bool) {
        self.reduced = reduced
        stage = .still(words)
    }

    public var outDuration: Double { reduced ? MotionValues.fast : MotionValues.swapOut }
    public var inDuration: Double { reduced ? MotionValues.fast : MotionValues.base }
    /// The words on screen now: exactly one set.
    public var words: String {
        switch stage {
        case .still(let w), .leaving(let w, _), .arriving(let w): w
        }
    }

    /// New words at `now`: the morph begins (or retargets an arrival).
    public mutating func set(_ next: String, at now: Double) {
        switch stage {
        case .still(let current) where current == next: return
        case .still(let current), .arriving(let current):
            stage = .leaving(current, next: next)
            startedAt = now
        case .leaving(let current, _):
            stage = .leaving(current, next: next)
        }
    }

    /// Moves the morph on to `now`.
    public mutating func tick(at now: Double) {
        switch stage {
        case .still: return
        case .leaving(_, let next):
            if now - startedAt >= outDuration {
                stage = .arriving(next)
                startedAt += outDuration
                tick(at: now)
            }
        case .arriving(let words):
            if now - startedAt >= inDuration { stage = .still(words) }
        }
    }

    /// How far up the words on screen sit (pt) and how opaque they are, at `now`.
    public func pose(at now: Double) -> (offset: Double, opacity: Double) {
        let t: Double
        switch stage {
        case .still: return (0, 1)
        case .leaving:
            t = min(1, max(0, (now - startedAt) / outDuration))
            let eased = MotionValues.easeSwap.value(at: t)
            return (reduced ? 0 : -Self.lift * eased, 1 - eased)
        case .arriving:
            t = min(1, max(0, (now - startedAt) / inDuration))
            let eased = MotionValues.easeSwap.value(at: t)
            return (reduced ? 0 : Self.lift * (1 - eased), eased)
        }
    }
}

/// What a watch and a wait are called, the desktop's shared/watch.ts.
public enum WatchWords {
    public static let waitTitleMax = 48

    private static let taskWords: [(SessionMeta.Background.Task.Kind, String, String)] = [
        (.shell, "a command", "commands"),
        (.monitor, "a monitor", "monitors"),
        (.agent, "a background agent", "background agents"),
        (.workflow, "a workflow", "workflows"),
        (.cron, "a wake-up", "wake-ups"),
        (.other, "a background task", "background tasks"),
    ]

    static func counted(_ n: Int, _ one: String, _ many: String) -> String {
        n == 1 ? one : "\(n) \(many)"
    }

    /// A cross-host child's `env_…:<sid>` names `<sid>`; any other id is itself.
    public static func bareAgentId(_ id: String) -> String {
        guard id.hasPrefix("env_"), let colon = id.firstIndex(of: ":") else { return id }
        return String(id[id.index(after: colon)...])
    }

    /// `text` cut to `max` at the last word boundary, "…" after.
    public static func cutAtWord(_ text: String, max: Int) -> String {
        let t = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard t.count > max else { return t }
        let head = String(t.prefix(max))
        if let space = head.lastIndex(of: " "), head.distance(from: head.startIndex, to: space) > max / 2 {
            return String(head[..<space]).trimmingCharacters(in: .whitespaces) + "…"
        }
        return String(head.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }

    private static func title(_ id: String, _ titleOf: (String) -> String?) -> String? {
        guard let t = titleOf(bareAgentId(id))?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return cutAtWord(t, max: waitTitleMax)
    }

    /// One agent by its title ("a subagent" while none is known), several counted.
    public static func waitSubject(_ ids: [String], titleOf: (String) -> String? = { _ in nil }) -> String {
        if ids.isEmpty { return "a subagent" }
        if ids.count == 1 { return title(ids[0], titleOf) ?? "a subagent" }
        return counted(ids.count, "a subagent", "subagents")
    }

    /// "Waiting on Review the payment flow".
    public static func waitLine(_ ids: [String], titleOf: (String) -> String? = { _ in nil }) -> String {
        "Waiting on \(waitSubject(ids, titleOf: titleOf))"
    }

    /// One task alone by its label, one subagent alone by its title, else
    /// counted, batch first; "" for nothing.
    public static func watchPhrase(_ bg: SessionMeta.Background?, titleOf: (String) -> String? = { _ in nil }) -> String {
        guard let bg else { return "" }
        let batchOut = (bg.batch?.out ?? 0) > 0
        if bg.tasks.count == 1, bg.agents.isEmpty, !batchOut {
            let label = bg.tasks[0].label.trimmingCharacters(in: .whitespaces)
            if !label.isEmpty { return label }
        }
        if bg.agents.count == 1, bg.tasks.isEmpty, !batchOut, let t = title(bg.agents[0], titleOf) { return t }
        var parts: [String] = []
        if let batch = bg.batch, batch.out > 0 { parts.append(counted(batch.out, "a batch thread", "batch threads")) }
        if !bg.agents.isEmpty { parts.append(counted(bg.agents.count, "a subagent", "subagents")) }
        for (kind, one, many) in taskWords {
            let n = bg.tasks.filter { $0.kind == kind }.count
            if n > 0 { parts.append(counted(n, one, many)) }
        }
        return parts.joined(separator: ", ")
    }

    /// Never empty: the phrase, else a master's batch steps, else background work.
    public static func watchSubject(_ bg: SessionMeta.Background?, titleOf: (String) -> String? = { _ in nil }) -> String {
        let phrase = watchPhrase(bg, titleOf: titleOf)
        if !phrase.isEmpty { return phrase }
        return bg?.batch != nil ? "the batch's steps" : "background work"
    }

    /// Watching past the stale mark on nothing but its own tasks (`nowMs`).
    public static func isStale(_ meta: SessionMeta, nowMs: Int) -> Bool {
        guard meta.status == .watching, let bg = meta.background, let since = bg.watchingSince,
              Double(nowMs - since) > MotionValues.staleWatch * 1_000 else { return false }
        return bg.agents.isEmpty && bg.batch == nil
    }
}

/// The turn's closing words: "Worked for 2m 4s", or "Worked" until the time lands.
public enum TurnEndWords {
    public static func worked(ms: Int?) -> String {
        guard let ms else { return "Worked" }
        return "Worked for \(ThoughtLine.spanWords(ms: ms))"
    }
}
