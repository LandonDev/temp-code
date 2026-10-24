import SwiftUI

/// The bar items' rules on the iPhone Duo (docs/IOS-DESIGN.md "Bars"). On
/// the inner display the system lays a navigation stack's bars out in a
/// vertical rail and leaves a title-only item out of it, so an item on a
/// screen in a stack carries an SF Symbol; a sheet opts into horizontal bars
/// (Design/SheetShape.swift) and its text items stay. Nothing hand-builds a
/// bar.
extension ToolbarContent {
    /// The item that must stay when a bar runs short: a sheet's Save, Start,
    /// Add or Done, a screen's New Thread, Settings or its menu. The first to
    /// overflow is whatever did not ask.
    @ToolbarContentBuilder
    func highVisibility() -> some ToolbarContent {
        if #available(iOS 27, *) {
            visibilityPriority(.high)
        } else {
            self
        }
    }

    /// An item with no vertical form (a title drawn as the principal item):
    /// the rail never tries to stand it up.
    @ToolbarContentBuilder
    func horizontalOnly() -> some ToolbarContent {
        if #available(iOS 27.1, *) {
            axisBehavior(.horizontalOnly)
        } else {
            self
        }
    }
}

extension EnvironmentValues {
    /// True under a toolbar item, for a view with two homes (the project
    /// plan chip: a capsule in a row, a `Label` the system draws in a bar).
    @Entry var inBar = false
}
