import ComputerProtocol
@testable import ComputerServiceKit
import Testing

/// §27.7 and §27.7a: text and keys at the live focus, never into a password field by name or by focus.
@Suite struct FocusPlanTests {
    let type = ComputerAction(action: .type, text: "hello")

    func focus(inScope: Bool = true, targeted: Bool = false, moved: Bool = false, navigates: Bool = false, secure: Bool = false, browser: Bool = false) -> FocusPlan.Focus {
        FocusPlan.Focus(inScope: inScope, insideTargeted: targeted, movedByStepBefore: moved, stepBeforeNavigates: navigates, secure: secure, browserField: browser)
    }

    @Test func onlyBlindKeysAndTextAfterAnInputStepAreJudged() {
        #expect(FocusPlan.applies(type, inputBefore: true))
        #expect(!FocusPlan.applies(type, inputBefore: false))
        #expect(!FocusPlan.applies(ComputerAction(action: .type, element: 4, text: "x"), inputBefore: true))
        #expect(!FocusPlan.applies(ComputerAction(action: .type, text: "x", named: "Name"), inputBefore: true))
        #expect(FocusPlan.applies(ComputerAction(action: .holdKey, text: "shift", duration: 1), inputBefore: true))
        #expect(!FocusPlan.applies(ComputerAction(action: .leftClick, element: 3), inputBefore: true))
    }

    @Test func aFieldAnEarlierStepClickedTakesTheText() {
        #expect(FocusPlan.verdict(type, focus: focus(targeted: true)) == .run)
    }

    /// An existing field the read never listed: refused unless a step targeted it or the step before focused it.
    @Test func anExistingFieldNoStepAimedAtIsRefused() {
        #expect(FocusPlan.verdict(type, focus: focus()) == .unplanned)
        #expect(FocusPlan.verdict(type, focus: focus(moved: true)) == .run)
    }

    @Test func aTabOntoAFieldDoesNotLicenseTyping() {
        let tab = ComputerAction(action: .key, text: "Tab")
        #expect(FocusPlan.isNavigationKey(tab))
        #expect(FocusPlan.verdict(type, focus: focus(moved: true, navigates: FocusPlan.isNavigationKey(tab))) == .unplanned)
    }

    /// Finder's rename: Return on a selected row opens an inline field and focuses it.
    @Test func aReturnThatOpensAnInlineRenameFieldTakesTheText() {
        let enter = ComputerAction(action: .key, text: "Return")
        #expect(!FocusPlan.isNavigationKey(enter))
        #expect(FocusPlan.verdict(type, focus: focus(moved: true, navigates: FocusPlan.isNavigationKey(enter))) == .run)
    }

    @Test func aFocusOutsideTheWindowAndWhatTheCallOpenedIsRefused() {
        #expect(FocusPlan.verdict(type, focus: focus(inScope: false, targeted: true, moved: true)) == .unplanned)
    }

    @Test func aPasswordFieldByFocusIsRefusedSecure() {
        #expect(FocusPlan.verdict(type, focus: focus(targeted: true, secure: true)) == .secure)
        #expect(FocusPlan.verdict(ComputerAction(action: .paste, text: "x"), focus: focus(moved: true, secure: true)) == .secure)
        // a key writes nothing a password field keeps: Return submits the form
        #expect(FocusPlan.verdict(ComputerAction(action: .key, text: "Return"), focus: focus(targeted: true, secure: true)) == .run)
    }

    @Test func aPasswordFieldByNameIsRefusedSecure() {
        #expect(FocusPlan.namedVerdict(ComputerAction(action: .type, text: "x", named: "Password"), secure: true) == .secure)
        #expect(FocusPlan.namedVerdict(ComputerAction(action: .setValue, value: "x", named: "Password"), secure: true) == .secure)
        #expect(FocusPlan.namedVerdict(ComputerAction(action: .leftClick, named: "Password"), secure: true) == .run)
        #expect(FocusPlan.namedVerdict(ComputerAction(action: .type, text: "x", named: "Name"), secure: false) == .run)
    }

    @Test func theBrowserFieldRuleRunsFirstAndNothingFocusedRuns() {
        #expect(FocusPlan.verdict(type, focus: focus(browser: true)) == .run)
        #expect(FocusPlan.verdict(type, focus: nil) == .run)
    }

    @Test func theNavigationKeysAloneOrWithShift() {
        for text in ["Tab", "shift+Tab", "Left", "Down", "Home", "End", "Page_Up", "page_down", "shift+End"] {
            #expect(FocusPlan.isNavigationKey(ComputerAction(action: .key, text: text)), "\(text)")
        }
        for text in ["Return", "super+Tab", "ctrl+Left", "a", "space"] {
            #expect(!FocusPlan.isNavigationKey(ComputerAction(action: .key, text: text)), "\(text)")
        }
        #expect(!FocusPlan.isNavigationKey(ComputerAction(action: .type, text: "Tab")))
    }

    @Test func theRefusalsCarryTheFocusedLine() {
        let brief = ElementBrief(index: 9, line: "input \"Address and search bar\"")
        let unplanned = FocusPlan.error(.unplanned, focused: brief, line: "input")
        #expect(unplanned?.kind == .focusMoved && unplanned?.reason == .unplanned && unplanned?.element == 9 && unplanned?.focused == brief)
        #expect(unplanned?.message == "[9] input \"Address and search bar\" has the focus, which no step of this batch aimed at; name the element the text is for.")
        let secure = FocusPlan.error(.secure, focused: ElementBrief(index: 12, line: "password \"Password\""), line: "password")
        #expect(secure?.reason == .secure && secure?.message == "[12] password \"Password\" can only be typed into by its element, so the person can be asked.")
        #expect(FocusPlan.error(.run, focused: brief, line: "") == nil)
    }
}
