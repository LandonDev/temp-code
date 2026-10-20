import SwiftUI
import TempCodeClient

@main
struct TempCodeApp: App {
    @UIApplicationDelegateAdaptor(PushDelegate.self) private var pushDelegate
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(model.router)
                .task { await model.start() }
        }
        .onChange(of: scenePhase) { _, phase in
            Task { await model.scenePhaseChanged(phase) }
        }
    }
}
