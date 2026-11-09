import Foundation

/// Flow control for one preview stream (docs/computer-protocol.md §6). Pure; the stream drives it
/// on its serial queue with its own clock.
///
/// At most `slots` frames are out without an ack. A new sample while every slot is taken is held,
/// replacing any older held one, so nothing is encoded that will not be sent and the newest
/// picture always goes next. An ack covers every earlier frame too: the pipe is ordered, so a host
/// that acked seq N has every frame before it. A frame left unacked for `starveAfterMs` starves the
/// stream: it should stop capturing until the next ack, which resumes it.
public struct FrameGate<Sample> {
    private let slots: Int
    private let starveAfterMs: Double
    /// Sent frames awaiting their ack: seq → when its starvation clock started.
    private var unacked: [Int: Double] = [:]
    /// A slot taken by a sample being encoded, not yet sent.
    private var reserved = false
    private var held: Sample?
    private var lastSeq = 0
    public private(set) var starved = false

    public init(slots: Int = CaptureTuning.unackedSlots, starveAfterMs: Double = CaptureTuning.starveAfter.milliseconds) {
        self.slots = slots
        self.starveAfterMs = starveAfterMs
    }

    /// Frames out without an ack, counting one being encoded.
    public var outstanding: Int { unacked.count + (reserved ? 1 : 0) }
    public var hasHeld: Bool { held != nil }

    /// A sample with new pixels arrived. Returns it when a slot is free (now reserved: encode it,
    /// then call `sent` or `notSent`); nil when it was held.
    public mutating func offer(_ sample: Sample) -> Sample? {
        if outstanding < slots {
            reserved = true
            return sample
        }
        held = sample
        return nil
    }

    /// The reserved frame went out: its seq, from 1, always growing.
    public mutating func sent(atMs: Double) -> Int {
        reserved = false
        lastSeq += 1
        unacked[lastSeq] = atMs
        return lastSeq
    }

    /// The reserved frame was dropped (over the size cap): its slot frees, and a held sample, if
    /// any, takes it.
    public mutating func notSent() -> Sample? {
        reserved = false
        return takeHeld()
    }

    public struct Ack {
        /// The held sample, now with a reserved slot: encode and send it.
        public let send: Sample?
        /// The stream was starved and should resume capturing.
        public let resume: Bool
    }

    /// The host acked `seq` (and so every frame before it). An unknown (never sent) or repeated
    /// ack changes nothing. A resume restarts the starvation clock of every frame still out.
    public mutating func ack(_ seq: Int, atMs: Double) -> Ack {
        let covered = seq <= lastSeq ? unacked.keys.filter { $0 <= seq } : []
        guard !covered.isEmpty else { return Ack(send: nil, resume: false) }
        for key in covered { unacked[key] = nil }
        let resume = starved
        if resume {
            starved = false
            for key in unacked.keys { unacked[key] = atMs }
        }
        return Ack(send: takeHeld(), resume: resume)
    }

    /// The stream's clock. True once, when a frame has been out unacked for `starveAfterMs`:
    /// the stream should pause.
    public mutating func tick(atMs: Double) -> Bool {
        guard !starved, let oldest = unacked.values.min(), atMs - oldest >= starveAfterMs else { return false }
        starved = true
        return true
    }

    private mutating func takeHeld() -> Sample? {
        guard let sample = held, outstanding < slots else { return nil }
        held = nil
        reserved = true
        return sample
    }
}

extension FrameGate: Sendable where Sample: Sendable {}
