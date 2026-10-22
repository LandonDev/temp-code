import TempCodeClient
import TempCodeContract

extension ThreadRowModel {
    /// A needs-you row is the one `ThreadRow` with its second line replaced
    /// by the cue ("Approve: run bun test", "Question: which email?",
    /// "Paused") and its time reading how long it has waited. The status
    /// keeps the dot (warning, destructive, or the pause mark); nothing runs,
    /// so the time never ticks as an elapsed. A waiting subagent is listed
    /// too and keeps its indent and agent glyph.
    static func needsYou(item: NeedsYouItem, cue: HomeModel.Cue?) -> ThreadRowModel {
        let meta = item.meta
        let child = meta.parentId != nil
        return ThreadRowModel(
            title: meta.title.isEmpty ? (child ? "Subagent" : "Untitled") : meta.title,
            type: meta.threadType,
            status: meta.status,
            unseen: false,
            model: ModelName.short(meta.model),
            detail: cue?.text ?? HomeModel.cue(for: item, rows: []).text,
            updatedAt: item.since,
            busySince: nil,
            running: false,
            pinned: meta.pinned,
            agent: child ? meta.agentType : nil
        )
    }
}
