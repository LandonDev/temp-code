import SwiftUI

/// The one SwiftUI piece Settings, Hosts and the pairing sheet share. The
/// words they say (the connection word, the fixes, the build line, the
/// capability titles) are the client package's `Shell/HostPresentation.swift`,
/// where they have tests.

/// A refusal under a field: glyph and one sentence in destructive, footnote
/// size, inside the field's own section so it reads as part of the field.
/// The caller gives it `.rowAppearTransition()`: it arrives with the
/// needs-you row motion (200 ms, 8 pt of travel) and leaves with a 150 ms
/// fade; reduced motion fades both ways.
struct InlineFieldError: View {
    let message: String

    var body: some View {
        Label {
            Text(message)
                .font(.footnote)
        } icon: {
            // The glyph's stroke matches the regular footnote beside it.
            Image(systemName: "exclamationmark.circle")
                .font(.footnote)
        }
        .foregroundStyle(Tint.destructive)
        .accessibilityIdentifier("field-error")
    }
}
