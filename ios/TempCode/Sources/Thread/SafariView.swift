import SafariServices
import SwiftUI

/// A web page inside the app: Safari's view controller as a full-screen
/// cover with a Done button and the research tint on its controls; reader
/// mode stays off so the page opens as the site serves it. Used by the
/// source rows and the report's citations; `.safariCover(_:)` presents it
/// for an optional page binding.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let configuration = SFSafariViewController.Configuration()
        configuration.entersReaderIfAvailable = false
        let controller = SFSafariViewController(url: url, configuration: configuration)
        controller.dismissButtonStyle = .done
        controller.preferredControlTintColor = UIColor(Tint.cyan)
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

/// A url to show, identified by itself so a cover can take it as an item.
struct WebPage: Identifiable, Hashable {
    let url: URL
    var id: URL { url }
}

extension View {
    /// Presents the page while the binding holds one; dismissing clears it.
    func safariCover(_ page: Binding<WebPage?>) -> some View {
        fullScreenCover(item: page) { page in
            SafariView(url: page.url)
                .ignoresSafeArea()
        }
    }
}
