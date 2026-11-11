import Foundation
import Observation

/// What the person has typed into a composer, kept where one small view
/// reads it. The text was the bar's own state, so every key ran the whole
/// bar: the box, the button, the row under it. Here the field alone reads
/// `text`, and everything else reads `hasContent`, which is assigned only
/// when it flips: a key that leaves the box neither newly empty nor newly
/// filled runs nothing outside the field.
///
/// The field's setter hands over what the system gave it, verbatim and at
/// once (`type`): nothing is deferred, normalised or written back, so an
/// input method's marked text and a dictation survive. Every other write
/// is a named one: the click's `clear`, a refusal's `restore`, a proof's
/// `seed`. Only `type` is a person's edit (`onEdit`).
@MainActor @Observable
public final class ComposerDraft {
    public private(set) var text = ""
    /// The box holds something a send would send: not empty, and not white space alone.
    public private(set) var hasContent = false
    /// A person edited the text (the field's setter, and nothing else).
    @ObservationIgnored public var onEdit: (@MainActor () -> Void)?

    public init() {}

    /// The field's own echo of a key, a paste, a dictation.
    public func type(_ new: String) {
        store(new)
        onEdit?()
    }

    /// The send took the words: the box is empty at the click.
    public func clear() {
        store("")
    }

    /// A refused send gives its words back over what was typed meanwhile:
    /// the sent text first, the later words after a blank line
    /// (`ProjectDraft.restoring`'s rule, for every composer).
    public func restore(_ sent: String) {
        store(Self.restored(sent: sent, later: text))
    }

    /// Text put in the box as if typed (a proof's draft, a restored draft).
    public func seed(_ text: String) {
        store(text)
    }

    /// What a send sends: the text with the white space around it gone.
    public var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func store(_ new: String) {
        if new != text { text = new }
        let content = Self.hasContent(new)
        if content != hasContent { hasContent = content }
    }

    /// The send's own test, stopped at the first scalar that is no white
    /// space: a box of newlines, tabs or ideographic spaces has no content.
    public static func hasContent(_ text: String) -> Bool {
        text.unicodeScalars.contains { !CharacterSet.whitespacesAndNewlines.contains($0) }
    }

    public static func restored(sent: String, later: String) -> String {
        later.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? sent : sent + "\n\n" + later
    }
}
