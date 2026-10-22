import TempCodeClient

/// A waiting thread's row says what it was doing when it stopped to ask: the
/// first line of its notes' State (the desktop's needs-you banner), in place
/// of the cue's text. The cue's seq stays, so the tap still lands on the card.
enum NeedsYouNotes {
    static func cue(_ cue: HomeModel.Cue, for item: NeedsYouItem, client: EnvironmentClient) async -> HomeModel.Cue {
        guard item.kind == .waiting, let doc = await client.loadNotes(item.id),
              let line = Notes.needsYouLine(waiting: true, text: doc.text) else { return cue }
        return HomeModel.Cue(text: line, seq: cue.seq)
    }
}
