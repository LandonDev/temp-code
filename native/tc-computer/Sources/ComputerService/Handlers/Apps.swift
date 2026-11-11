import ComputerCore
import ComputerProtocol
import ComputerServiceKit
import Foundation

extension ComputerService {
    func registerApps() {
        router.on("apps.list") { [self] (p: Methods.AppsList.Params, _) in try await appsList(windows: p.windows ?? false) }
        // items checked and the app refused or resolved before anything opens, then one open under the front guard (§23)
        router.on("apps.launch") { [self] (p: Methods.AppsLaunch.Params, _) -> Methods.AppsLaunch.Output in
            try await inventory.launch(p.app, open: p.open ?? [], session: p.session, refuse: p.refuse ?? [])
        }
    }

    func registerSessions() {
        router.on("session.open") { [self] (p: SessionRef, _) -> Empty in
            guard ComputerService.validSessionID(p.session) else {
                throw RPCFailure.invalidParams("session: an id of 1 to 64 letters, digits, _ or -")
            }
            book.open(p.session)
            input.watchKeys(true)
            return Empty()
        }
        router.on("session.close") { [self] (p: SessionRef, _) -> Empty in
            await closeSession(p.session)
            return Empty()
        }
    }

    private static let sessionIDCharacters = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")

    /// Capture's rule for a session id, which names a directory under `shots/`: `^[A-Za-z0-9_-]{1,64}$`.
    static func validSessionID(_ id: String) -> Bool {
        (1...64).contains(id.count) && id.allSatisfy(sessionIDCharacters.contains)
    }

    /// Regular apps, the frontmost first, then by name; with `windows`, each app's windows (2 s per app, an
    /// app that does not answer lists none and is named in a `log` warn).
    func appsList(windows: Bool) async throws -> Methods.AppsList.Output {
        if windows { try requireAccessibility() }
        let apps = inventory.sortedRunning()
        guard windows else {
            return Methods.AppsList.Output(apps: apps.map { AppInfo(pid: Int($0.pid), bundleId: $0.bundleId, name: $0.name, active: $0.active, hidden: $0.hidden) })
        }
        let source = modules.windows
        let lists = await withTaskGroup(of: (Int32, [WindowInfo]?).self) { group in
            for app in apps {
                group.addTask { [self] in
                    let pid = app.pid
                    return (pid, try? await blocking { try source.list(pid: pid) })
                }
            }
            var out: [Int32: [WindowInfo]?] = [:]
            for await (pid, list) in group { out[pid] = list }
            return out
        }
        var infos: [AppInfo] = []
        for app in apps {
            let list = lists[app.pid] ?? nil
            if list == nil { log(.warn, "\(app.name) did not answer for its windows") }
            infos.append(AppInfo(pid: Int(app.pid), bundleId: app.bundleId, name: app.name, active: app.active, hidden: app.hidden, windows: list ?? []))
        }
        return Methods.AppsList.Output(apps: infos)
    }

    /// Closes the session to new calls, cancels its requests in flight and waits for them (so none posts
    /// input or opens a stream after the close), then lets go of its held input, stops its streams, closes
    /// its readers and drops its workers.
    func closeSession(_ session: String) async {
        book.close(session)
        if book.openCount == 0 { input.watchKeys(false) }
        // the router's cancel sets each flag and cancels each task, which wakes one waiting for its app's slot
        let ids = lock.withLock { sessionRequests[session].map { Array($0.keys) } ?? [] }
        for id in ids { router.cancel(id) }
        let deadline = ContinuousClock.now + env.timing.closeWait
        while lock.withLock({ sessionRequests[session] != nil }) && ContinuousClock.now < deadline {
            try? await Task.sleep(for: .milliseconds(5))
        }
        await releaseHeld(session: session)
        let ending: [StreamEntry] = lock.withLock {
            clicks.forget(session: session)
            let mine = streams.values.filter { $0.session == session }
            for entry in mine { streams[entry.id] = nil }
            return Array(mine)
        }
        for entry in ending {
            await entry.handle.stop()
            notify("capture/streamEnded", CaptureStreamEndedNotification.Params(stream: entry.id, reason: .stopped))
        }
        readers.close(session: session)
        workers.drop(session: session)
        capture.forget(session: session)
    }
}
