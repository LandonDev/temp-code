import Foundation

/// How long a test waits for something that has to happen: an event on a
/// fake socket, a task hopping back to the main actor, a request leaving.
/// The release gate runs this suite beside the app's signing, and there every
/// test took about 21 s: a 3 s deadline ran out while the process sat
/// unscheduled, with nothing wrong. A wait returns the moment its condition
/// holds, so only a test that is failing anyway pays the whole deadline.
/// Never use a wait to prove that something does not happen; drive a
/// `ManualClock` past the moment instead.
let waitDeadline: Duration = .seconds(60)

/// Polls `condition` every millisecond until it holds or `waitDeadline`
/// passes, on the caller's actor. The condition is asked once more after the
/// deadline, so a process that slept through it still sees what landed.
func eventually(_ condition: () async -> Bool) async -> Bool {
    let deadline = ContinuousClock.now.advanced(by: waitDeadline)
    while true {
        if await condition() { return true }
        if ContinuousClock.now >= deadline { return false }
        try? await Task.sleep(for: .milliseconds(1))
    }
}
