import SwiftUI
import TempCodeClient
import UIKit

/// A person's tap resizing a transcript row in place (a tool group opening
/// or folding), glided on the layout spring by UIKit itself. A `List` never
/// animates its cells' frames from a SwiftUI transaction: the row's cell
/// took its new height in one frame and every row under it jumped. So the
/// change is laid out at once inside a UIKit spring with the layout spring's
/// physics (`MotionValues.springLayout`): the cell's height, the rows under
/// it and, for a reader at the bottom, the offset to the new end move as one
/// motion, while the row's own content fades on its SwiftUI transitions.
///
/// In content coordinates only the rows under the resized one move, by its
/// change in height. UIKit moves the cells drawn before and after; a row the
/// change brings on screen starts that far back and glides in, and a row it
/// takes off screen is drawn by a still image of its cell, as it was last
/// on screen, that glides out and leaves at the end. The rows clip to their cells while it runs, so an
/// opening table never draws over the rows sliding down, and a folding one
/// is cut by its shrinking cell.
enum ListGlide {
    /// A leaving row's still image (its `tag` the row's item): the glide proof samples it.
    static let stillID = "list-glide-still"

    static func run(_ scroll: UIScrollView, follow: Bool, change: () -> Void) {
        guard let list = scroll as? UICollectionView else {
            withAnimation(Motion.layout) { change() }
            return
        }
        let spring = MotionValues.springLayout
        let timing = UISpringTimingParameters(mass: spring.mass, stiffness: spring.stiffness, damping: spring.damping, initialVelocity: .zero)
        let animator = UIViewPropertyAnimator(duration: MotionValues.layout, timingParameters: timing)
        let before = cells(list)
        let frames = before.mapValues(\.frame)
        var clipped = Set(before.values.filter { !$0.clipsToBounds }.map(ObjectIdentifier.init))
        before.values.forEach { $0.clipsToBounds = true }
        var leaving: [UIView] = []
        var entered: [UICollectionViewCell] = []
        // One owner per motion: UIKit moves the geometry; SwiftUI animates no layout
        // inside the cell (its own spring there slid the row's line against the
        // cell's) and keeps only what carries its own animation (the content's
        // fades on their transitions, the chevron's turn).
        withTransaction(Transaction(animation: nil)) { change() }
        animator.addAnimations {
            // The SwiftUI update lands here, inside the spring.
            list.window?.layoutIfNeeded()
            list.performBatchUpdates(nil)
            if follow {
                list.contentOffset.y = max(-list.adjustedContentInset.top, list.contentSize.height + list.adjustedContentInset.bottom - list.bounds.height)
            }
            list.layoutIfNeeded()
            let after = cells(list)
            guard let (row, shift) = resized(before: frames, after: after) else { return }
            for (path, cell) in after where before[path] == nil {
                if !cell.clipsToBounds { clipped.insert(ObjectIdentifier(cell)); cell.clipsToBounds = true }
                entered.append(cell)
                guard path > row else { continue }
                UIView.performWithoutAnimation { cell.frame.origin.y -= shift }
                cell.frame.origin.y += shift
            }
            // A row leaving the screen is drawn as it was last on screen: a still
            // image (a live snapshot goes blank as the list hides the cell).
            // Leaving by where it ends: the list drops a cell it no longer shows in a
            // later layout pass, not always in this one.
            for (path, frame) in frames where after[path] == nil || !frame.offsetBy(dx: 0, dy: path > row ? shift : 0).intersects(list.bounds) {
                guard let cell = before[path] else { continue }
                let image = UIGraphicsImageRenderer(size: frame.size, format: UIGraphicsImageRendererFormat(for: list.traitCollection)).image { _ in
                    _ = cell.drawHierarchy(in: CGRect(origin: .zero, size: frame.size), afterScreenUpdates: false)
                }
                let still = UIImageView(image: image)
                still.accessibilityIdentifier = stillID
                still.tag = path.item
                UIView.performWithoutAnimation {
                    still.frame = frame
                    list.addSubview(still)
                }
                leaving.append(still)
                if path > row { still.frame.origin.y += shift }
            }
        }
        animator.addCompletion { _ in
            leaving.forEach { $0.removeFromSuperview() }
            for cell in before.values + entered where clipped.contains(ObjectIdentifier(cell)) { cell.clipsToBounds = false }
        }
        animator.startAnimation()
    }

    private static func cells(_ list: UICollectionView) -> [IndexPath: UICollectionViewCell] {
        var out: [IndexPath: UICollectionViewCell] = [:]
        for cell in list.visibleCells { if let path = list.indexPath(for: cell) { out[path] = cell } }
        return out
    }

    /// The row whose height changed most, and by how much (what the rows under it move).
    private static func resized(before: [IndexPath: CGRect], after: [IndexPath: UICollectionViewCell]) -> (IndexPath, CGFloat)? {
        let changes = after.compactMap { path, cell -> (IndexPath, CGFloat)? in
            guard let old = before[path] else { return nil }
            return (path, cell.frame.height - old.height)
        }
        guard let most = changes.max(by: { abs($0.1) < abs($1.1) }), abs(most.1) >= 0.5 else { return nil }
        return most
    }
}
