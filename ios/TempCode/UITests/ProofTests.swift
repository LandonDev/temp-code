import XCTest

/// The simulator proof (scripts/ios-sim-proof.sh): launch with a pairing
/// link in the environment, see the host appear and connect, open its
/// threads, open a thread, and keep a screenshot of each screen.
final class ProofTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testEnvironmentsThreadsAndATranscript() throws {
        let app = XCUIApplication()
        let env = ProcessInfo.processInfo.environment
        app.launchEnvironment["TC_TEST_PAIR_LINK"] = env["TC_TEST_PAIR_LINK"] ?? ""
        app.launchEnvironment["TC_TEST_PAIR_NAME"] = env["TC_TEST_PAIR_NAME"] ?? ""
        app.launch()

        let host = app.cells.matching(identifier: "environment-row").firstMatch
        XCTAssertTrue(host.waitForExistence(timeout: 60), "the paired host never appeared")
        let connected = host.staticTexts["Connected"]
        XCTAssertTrue(connected.waitForExistence(timeout: 60), "the host never connected")
        keep(app, "01-hosts")

        host.tap()
        let thread = app.cells.matching(identifier: "thread-row").firstMatch
        XCTAssertTrue(thread.waitForExistence(timeout: 60), "no thread listed")
        keep(app, "02-threads")

        thread.tap()
        let item = app.otherElements.matching(identifier: "transcript-item").firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 60), "the transcript never painted")
        // Let the first page settle and images load.
        sleep(3)
        keep(app, "03-thread")
        app.swipeDown()
        sleep(1)
        keep(app, "04-thread-earlier")
    }

    @MainActor
    private func keep(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
