import Foundation
import Testing
import TempCodeContract
@testable import TempCodeClient

@Suite struct StripWordsTests {
    @Test func `the queued line splits the host's reason off as its own detail`() {
        #expect(StripWords.queued(activity: "Queued · waiting for Build the share sheet") == StripWords(title: "Queued", detail: "Waiting for Build the share sheet"))
        #expect(StripWords.queued(activity: "Queued · waiting for Port it (errored)") == StripWords(title: "Queued", detail: "Waiting for Port it (errored)"))
        #expect(StripWords.queued(activity: "Queued · 120 of 120 running") == StripWords(title: "Queued", detail: "120 of 120 running"))
        #expect(StripWords.queued(activity: "Queued") == StripWords(title: "Queued"))
        #expect(StripWords.queued(activity: nil) == StripWords(title: "Queued"))
        #expect(StripWords.queued(activity: "Reading files") == StripWords(title: "Queued"), "an activity that is not the host's queued line says nothing more")
    }

    @Test func `the queued line reads the host's current shape, two spaces and a lower-case reason`() {
        #expect(StripWords.queued(activity: "Queued  waiting for memory") == StripWords(title: "Queued", detail: "Waiting for memory"))
        #expect(StripWords.queued(activity: "Queued  120 of 120 running") == StripWords(title: "Queued", detail: "120 of 120 running"))
        #expect(StripWords.queued(activity: "Queued: waiting for memory") == StripWords(title: "Queued", detail: "Waiting for memory"))
        for line in ["Queued  waiting for memory", "Queued · waiting for memory"] {
            let detail = StripWords.queued(activity: line).detail ?? ""
            #expect(!detail.contains("  ") && !detail.contains("·") && !detail.contains("—"))
        }
    }

    @Test func `a turn's phase is the host's phase line, its first words the title and the rest the detail`() {
        #expect(StripWords.phase(activity: "Starting the CLI") == StripWords(title: "Starting the CLI"))
        #expect(StripWords.phase(activity: "Initializing") == StripWords(title: "Initializing"))
        #expect(StripWords.phase(activity: "Waiting for the provider · 25 s") == StripWords(title: "Waiting for the provider", detail: "25 s"))
        #expect(StripWords.phase(activity: "Rate limited · retry 3 in 32 s") == StripWords(title: "Rate limited", detail: "Retry 3 in 32 s"))
        #expect(StripWords.phase(activity: "Provider overloaded · retry 1 in 5 s") == StripWords(title: "Provider overloaded", detail: "Retry 1 in 5 s"))
        #expect(StripWords.phase(activity: "Retrying") == StripWords(title: "Retrying"))
        #expect(StripWords.phase(activity: "Reconnecting · retry 2 of 5") == StripWords(title: "Reconnecting", detail: "Retry 2 of 5"))
        #expect(StripWords.phase(activity: "Thinking") == nil)
        #expect(StripWords.phase(activity: "Initializing the repo") == nil, "a tool's line that starts like a phase is not one")
        #expect(StripWords.phase(activity: nil) == nil)
    }

    @Test func `paused names the batch only on a master with paused threads, stopped names the harness`() {
        #expect(StripWords.paused(batch: 0) == StripWords(title: "Paused"))
        #expect(StripWords.paused(batch: 1) == StripWords(title: "Paused", detail: "1 batch thread with it"))
        #expect(StripWords.paused(batch: 3) == StripWords(title: "Paused", detail: "3 batch threads with it"))
        #expect(StripWords.stopped == StripWords(title: "Stopped", detail: "The harness is gone"))
    }
}
