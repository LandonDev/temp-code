import Foundation
import Testing
@testable import TempCodeClient

/// The layout rule on the iPhone Duo's four metrics, a Max phone and an iPad-class window.
@Suite struct ShellPoseTests {
    @Test func `unfolded landscape tiles the sidebar beside the detail`() {
        #expect(ShellPose.of(horizontal: .regular, vertical: .regular, size: CGSize(width: 951, height: 669)) == .split(sidebar: .tiled))
    }

    @Test func `unfolded portrait overlays the sidebar behind the system toggle`() {
        #expect(ShellPose.of(horizontal: .regular, vertical: .regular, size: CGSize(width: 669, height: 951)) == .split(sidebar: .overlay))
    }

    @Test func `folded portrait is the stack`() {
        #expect(ShellPose.of(horizontal: .compact, vertical: .regular, size: CGSize(width: 466, height: 678)) == .stack(short: false))
    }

    @Test func `folded landscape is the short stack`() {
        #expect(ShellPose.of(horizontal: .compact, vertical: .compact, size: CGSize(width: 678, height: 466)) == .stack(short: true))
    }

    @Test func `a Max phone is the stack upright and the split on its side, as its size classes say`() {
        #expect(ShellPose.of(horizontal: .compact, vertical: .regular, size: CGSize(width: 440, height: 956)) == .stack(short: false))
        // A Max phone on its side reads regular × compact: the width decides, as it does for NavigationSplitView.
        #expect(ShellPose.of(horizontal: .regular, vertical: .compact, size: CGSize(width: 956, height: 440)) == .split(sidebar: .tiled))
    }

    @Test func `a Pro phone on its side is the short stack`() {
        #expect(ShellPose.of(horizontal: .compact, vertical: .compact, size: CGSize(width: 874, height: 402)) == .stack(short: true))
    }

    @Test func `a regular square window tiles`() {
        #expect(ShellPose.of(horizontal: .regular, vertical: .regular, size: CGSize(width: 800, height: 800)) == .split(sidebar: .tiled))
    }

    @Test func `no size class yet reads as the stack`() {
        #expect(ShellPose.of(horizontal: nil, vertical: nil, size: .zero) == .stack(short: false))
    }

    @Test func `titles are inline only on the short stack`() {
        #expect(ShellPose.stack(short: true).titleDisplay == .inline)
        #expect(ShellPose.stack(short: false).titleDisplay == .large)
        #expect(ShellPose.split(sidebar: .tiled).titleDisplay == .large)
        #expect(ShellPose.split(sidebar: .overlay).titleDisplay == .large)
    }

    @Test func `isSplit, isStack and isOverlay`() {
        #expect(ShellPose.split(sidebar: .tiled).isSplit)
        #expect(!ShellPose.split(sidebar: .tiled).isStack)
        #expect(ShellPose.stack(short: false).isStack)
        #expect(ShellPose.split(sidebar: .overlay).isOverlay)
        #expect(!ShellPose.split(sidebar: .tiled).isOverlay)
    }
}
