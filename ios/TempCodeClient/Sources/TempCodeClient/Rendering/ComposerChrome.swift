import Foundation
import TempCodeContract

/// What the bottom dock draws of its thread's session, and nothing else of
/// it. The thread screen builds one from the meta and hands it down; no
/// `SessionMeta` goes below it. So the dock compares equal, and stays as it
/// is, through every meta that changes none of these (the activity line,
/// the time, the tasks), and a field the dock would read but this does not
/// carry cannot be read at all. Actions read the session as it is when
/// they run (`EnvironmentClient.currentSession`), never a copy from a body.
public struct ComposerChrome: Sendable, Equatable {
    /// The host lists the thread.
    public var exists: Bool
    public var status: SessionStatus?
    public var provider: ProviderId?
    public var model: String?
    public var reasoning: Reasoning?
    public var permission: PermissionPolicy?
    /// The context meter's level and window.
    public var context: SessionMeta.Context?
    /// The field's placeholder (`ComposerRules.placeholder`).
    public var placeholder: String
    public var isMaster: Bool
    /// When the host's turn began: the slot's timer when the click is not its start.
    public var busySince: Int?
    /// The frozen elapsed time, carried only while the thread is paused or stopped.
    public var frozen: Int?
    /// The queued row's words (`StatusWords.queuedLine`), carried only while queued.
    public var queued: StripWords?
    /// How many batch threads paused with a paused master.
    public var pausedBatch: Int

    public init(_ session: SessionMeta?, pausedBatch: Int = 0) {
        exists = session != nil
        status = session?.status
        provider = session?.provider
        model = session?.model
        reasoning = session?.reasoning
        permission = session?.permission
        context = session?.context
        placeholder = ComposerRules.placeholder(for: session)
        isMaster = session?.isMaster == true
        busySince = session?.busySince
        let held = session?.status == .paused || session?.status == .stopped
        frozen = held ? session?.frozenActiveElapsed : nil
        queued = session?.status == .queued ? session.map(StatusWords.queuedLine) : nil
        self.pausedBatch = session?.isMaster == true && session?.status == .paused ? pausedBatch : 0
    }
}
