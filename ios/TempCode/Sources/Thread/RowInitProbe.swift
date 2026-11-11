import Combine
import SwiftUI
import TempCodeClient

extension View {
    /// DEBUG only: counts this transcript row's state inits, appearances and
    /// disappearances by its key (`LayoutProbe.rowInit`); a Release build
    /// and a performance run return the view untouched.
    @ViewBuilder
    func rowInitProbe(_ id: TranscriptRowID) -> some View {
        #if DEBUG
        if LayoutProbe.off {
            self
        } else {
            modifier(RowInitProbe(key: RowInitLedger.key(id)))
        }
        #else
        self
        #endif
    }
}

#if DEBUG
/// A `@StateObject` is built once per identity (its autoclosure runs only
/// when SwiftUI makes the storage), so its init is the row's state init.
@MainActor private final class RowLife: ObservableObject {
    init(key: String) {
        LayoutProbe.rowInit(key)
    }
}

private struct RowInitProbe: ViewModifier {
    let key: String
    @StateObject private var life: RowLife

    init(key: String) {
        self.key = key
        _life = StateObject(wrappedValue: RowLife(key: key))
    }

    func body(content: Content) -> some View {
        content
            .onAppear { LayoutProbe.rowAppeared(key) }
            .onDisappear { LayoutProbe.rowDisappeared(key) }
    }
}
#endif
