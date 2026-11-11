import ComputerCore
import ComputerProtocol
import Foundation
import Testing
#if canImport(InputPure)
@testable import InputPure
#else
@testable import Input
#endif

// The `front` tier in the route plan (docs/computer-protocol.md §25.3). Foundation only: the box
// runs this file from scripts/computer-text-test.sh, the Mac in InputTests.

private let withFront: [Tier] = [.ax, .process, .front, .session]

private func routes(_ plan: RoutePlan) -> [String] {
    guard case .runs(let steps, _, _) = plan else { return [] }
    return steps.map { "\($0.route) \($0.tier.rawValue)\($0.exact ? "" : "~")" }
}

@Suite struct FrontRouteTests {
    let disabledSave = RouteFacts(menu: { MenuMatch(path: ["File", "Save"], indexPath: [2, 4], enabled: false) })

    @Test func frontComesBeforeSessionForEveryShortVerb() {
        let key = ComputerAction(action: .key, text: "Return")
        #expect(routes(planRoutes(key, element: nil, tiers: withFront, held: nil)) == ["events process", "events front", "events session"])
        let click = ComputerAction(action: .leftClick, coordinate: [5, 5])
        #expect(routes(planRoutes(click, element: nil, tiers: withFront, held: nil)) == ["events process", "events front", "events session"])
        // the tier order is TIER_ORDER's, whatever order the call lists them in
        #expect(routes(planRoutes(key, element: nil, tiers: [.session, .front, .process], held: nil)) == ["events process", "events front", "events session"])
    }

    @Test func frontRunsAfterAnApproximateAxRoute() {
        let scroll = ComputerAction(action: .scroll, coordinate: [5, 5], scroll_direction: .down, scroll_amount: 5)
        let area = RouteFacts(pageScrolls: { ["AXScrollDownByPage"] })
        #expect(routes(planRoutes(scroll, element: nil, facts: area, tiers: withFront, held: nil)) == ["events process", "scrollPage ax~", "events front", "events session"])
    }

    @Test func longOrHeldVerbsHaveNoFrontRoute() {
        let cases: [ComputerAction] = [
            ComputerAction(action: .holdKey, text: "shift", duration: 1),
            ComputerAction(action: .leftClickDrag, coordinate: [9, 9], start_coordinate: [1, 1]),
            ComputerAction(action: .leftMouseDown, coordinate: [1, 1]),
            ComputerAction(action: .leftMouseUp, coordinate: [1, 1]),
            ComputerAction(action: .mouseMove, coordinate: [1, 1]),
            ComputerAction(action: .leftClick, coordinate: [1, 1], duration: 1),
            ComputerAction(action: .key, text: "Down", repeat: InputTiming.frontKeyRepeatMax + 1)
        ]
        for a in cases {
            #expect(!hasFrontRoute(a), "\(a.action)")
            #expect(routes(planRoutes(a, element: nil, tiers: withFront, held: nil)) == ["events process", "events session"], "\(a.action)")
        }
        #expect(hasFrontRoute(ComputerAction(action: .key, text: "Down", repeat: InputTiming.frontKeyRepeatMax)))
        #expect(!hasFrontRoute(ComputerAction(action: .perform, element: 1, name: "raise")))
        #expect(hasFrontRoute(ComputerAction(action: .perform, element: 1, name: "press")))
        #expect(hasFrontRoute(ComputerAction(action: .saveAs, path: "~/run/a.txt")))
    }

    @Test func aDisabledShortcutRunsAtFrontAndSessionOnlyWithoutIt() {
        let save = ComputerAction(action: .key, text: "super+s")
        #expect(routes(planRoutes(save, element: nil, facts: disabledSave, tiers: withFront, held: nil)) == ["menu front"])
        #expect(chooseRoute(save, element: nil, facts: disabledSave, tiers: [.ax, .process, .session], held: nil) == .run(.session, .events, exact: true))
        #expect(chooseRoute(save, element: nil, facts: disabledSave, tiers: [.ax, .process], held: nil) == .needs(.front, menu: ["File", "Save"]))
        var active = disabledSave
        active.appActive = { true }
        #expect(chooseRoute(save, element: nil, facts: active, tiers: withFront, held: nil) == .disabledMenu(["File", "Save"]))
    }

    @Test func aMenuItemNamedDirectlyReadsItsEnabledFact() {
        let disabled = ElementFacts(role: "menu item", actions: ["AXPress", "AXPick"], menuItem: NamedMenuItem(path: ["File", "New Folder"], enabled: false))
        let enabled = ElementFacts(role: "menu item", actions: ["AXPress", "AXPick"], menuItem: NamedMenuItem(path: ["File", "New Folder"], enabled: true))
        for a in [ComputerAction(action: .perform, element: 3, name: "pick"), ComputerAction(action: .perform, element: 3, name: "press"), ComputerAction(action: .leftClick, element: 3)] {
            // enabled: AX alone, no posted click on a menu that is not drawn
            #expect(routes(planRoutes(a, element: enabled, tiers: withFront, held: nil)) == ["element ax"], "\(a.action)")
            // disabled in a background app: front, then session only when front is not allowed
            #expect(routes(planRoutes(a, element: disabled, tiers: withFront, held: nil)) == ["element front"], "\(a.action)")
            #expect(routes(planRoutes(a, element: disabled, tiers: [.ax, .process, .session], held: nil)) == ["element session"], "\(a.action)")
            #expect(chooseRoute(a, element: disabled, tiers: [.ax, .process], held: nil) == .needs(.front, menu: ["File", "New Folder"]), "\(a.action)")
            // disabled with the app active: no tier helps
            #expect(chooseRoute(a, element: disabled, facts: RouteFacts(appActive: { true }), tiers: withFront, held: nil) == .disabledMenu(["File", "New Folder"]), "\(a.action)")
        }
        // another perform on a menu item takes the element's own route
        let show = ComputerAction(action: .perform, element: 3, name: "show menu")
        #expect(routes(planRoutes(show, element: disabled, tiers: withFront, held: nil)) == ["element ax", "element front"])
    }

    @Test func aCommitStepInABackgroundAppSkipsProcess() {
        let enter = ComputerAction(action: .key, text: "Return")
        let commit = RouteFacts(appActive: { false }, commitExpected: { true })
        #expect(routes(planRoutes(enter, element: nil, facts: commit, tiers: withFront, held: nil)) == ["events front", "events session"])
        // front not allowed: process stays, nothing to skip it for
        #expect(routes(planRoutes(enter, element: nil, facts: commit, tiers: [.ax, .process, .session], held: nil)) == ["events process", "events session"])
        // the app already active: process is the app's own front, no hold needed
        let active = RouteFacts(appActive: { true }, commitExpected: { true })
        #expect(routes(planRoutes(enter, element: nil, facts: active, tiers: withFront, held: nil)) == ["events process", "events front", "events session"])
        // the fact is read only when front could take the step
        var asked = false
        _ = planRoutes(enter, element: nil, facts: RouteFacts(commitExpected: { asked = true; return true }), tiers: [.ax, .process], held: nil)
        #expect(!asked)
    }

    @Test func aClassWhoseFrontMissedTwiceRunsItsFrontLast() {
        let key = ComputerAction(action: .key, text: "Return")
        let ignored = IgnoredRoutes(process: [.key], front: [.key])
        #expect(routes(planRoutes(key, element: nil, tiers: withFront, held: nil, ignored: ignored)) == ["events session", "events process", "events front"])
        #expect(routes(planRoutes(key, element: nil, tiers: withFront, held: nil, ignored: IgnoredRoutes(process: [.key], front: [.key], skip: true))) == ["events session"])
        // another class is untouched
        let click = ComputerAction(action: .leftClick, coordinate: [1, 1])
        #expect(routes(planRoutes(click, element: nil, tiers: withFront, held: nil, ignored: ignored)) == ["events process", "events front", "events session"])
    }

    @Test func saveAsIsThePanelRoute() {
        let save = ComputerAction(action: .saveAs, path: "~/run/note.txt")
        #expect(routes(planRoutes(save, element: nil, tiers: withFront, held: nil)) == ["panel ax", "panel front"])
        #expect(planRoutes(save, element: nil, tiers: [.ax, .process], held: nil) == .runs([RouteStep(.ax, .panel)], needed: .front, menu: nil))
        #expect(Route.panel.via == .panel)
    }

    @Test func theKeyWindowRetryGoesToFrontBeforeSession() {
        let key = ComputerAction(action: .key, text: "a")
        guard case .runs(let steps, _, _) = planRoutes(key, element: nil, tiers: withFront, held: nil) else { Issue.record("no plan"); return }
        #expect(keyWindowRetry(Array(steps.dropFirst())) == RouteStep(.front, .events))
        guard case .runs(let old, _, _) = planRoutes(key, element: nil, tiers: [.ax, .process, .session], held: nil) else { Issue.record("no plan"); return }
        #expect(keyWindowRetry(Array(old.dropFirst())) == RouteStep(.session, .events))
        #expect(keyWindowRetry([]) == nil)
    }

    @Test func aHeldKeyStillForcesItsTier() {
        let key = ComputerAction(action: .key, text: "a")
        #expect(routes(planRoutes(key, element: nil, tiers: withFront, held: .session)) == ["events session"])
    }
}
