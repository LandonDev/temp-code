#if canImport(ApplicationServices)
@testable import AXReader
import Testing

/// The edited flag of an autosaving document is the title bar's status, never the close button alone (§26.8, E5).
@Suite struct EditedFlagTests {
    @Test func theCloseButtonSaysItForADocumentThatSavesOnRequest() {
        #expect(EditedFlag.of(closeButton: true, statusTitles: []) == true)
        #expect(EditedFlag.of(closeButton: false, statusTitles: []) == false)
    }

    @Test func anAutosavingDocumentSaysItInTheTitleBarInThePersonsLanguage() {
        #expect(EditedFlag.of(closeButton: false, statusTitles: ["Edited"]) == true)
        #expect(EditedFlag.of(closeButton: false, statusTitles: ["Bearbeitet"], word: "Bearbeitet") == true)
        #expect(EditedFlag.of(closeButton: false, statusTitles: ["Locked"]) == false)
    }

    @Test func aWindowWithNoCloseButtonAndNoStatusSaysNothing() {
        #expect(EditedFlag.of(closeButton: nil, statusTitles: []) == nil)
        #expect(EditedFlag.of(closeButton: nil, statusTitles: ["Edited"]) == true)
    }

    @Test func appKitsWordIsRead() {
        #expect(!EditedFlag.word.isEmpty)
    }
}
#endif
