import SwiftUI
import TempCodeClient

/// The assistant row while its text still streams: the one view the
/// transcript mounts for an assistant block with `streaming == true`. The
/// markdown parses incrementally on the main actor (the last changed block
/// only), so the earlier blocks keep their render and nothing flickers
/// between plain and styled. This file is the streaming thread's seam (the
/// jitter-buffer reveal, partial tool calls, live edits); the signature stays.
struct StreamingAssistantRow: View {
    let block: TextBlock

    var body: some View {
        MarkdownView(seq: block.seq, text: block.text, streaming: true)
            .textSelection(.enabled)
            .padding(.vertical, 6)
    }
}
