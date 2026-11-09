import ComputerProtocol
import ComputerServiceKit
import Foundation

extension ComputerService {
    func registerEscape() {
        // P1: the host turns the watch on while it holds a session and renews it; off, or no renewal, ends it
        router.on("escape.watch", slot: false) { [self] (p: Methods.EscapeWatch.Params, _) -> Empty in
            if p.on { try requireAccessibility() }
            do {
                try escape.set(on: p.on, leaseMs: p.leaseMs)
            } catch {
                pokePermissions()
                throw error
            }
            return Empty()
        }
    }
}
