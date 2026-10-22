import SwiftUI
import TempCodeClient
import TempCodeContract

/// The account a thread spends from, in the header's subtitle: a dot in the
/// account's colour and its short name, or "Auto" one step dimmer. Tap opens
/// the menu sheet (AccountMenu.swift). Nothing renders for a provider the
/// gateway does not route. docs/IOS-DESIGN.md "The account chip and menu".
struct AccountChip: View {
    let client: EnvironmentClient
    let session: SessionMeta
    @State private var open = false

    var body: some View {
        if let scope = AccountScope.of(session, projects: client.projects, workspaces: client.workspaces) {
            let accounts = client.accounts.snapshot.map { scope.provider.accounts(in: $0) }
            let label = AccountName.chipLabel(scope: scope, accounts: accounts)
            Button { open = true } label: {
                HStack(spacing: 5) {
                    if let label {
                        Circle()
                            .fill(AccountColor.of(scope.shown, in: accounts))
                            .frame(width: 6, height: 6)
                    }
                    Text(label ?? "Auto")
                        .font(.caption.weight(label == nil ? .regular : .medium))
                        .foregroundStyle(label == nil ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.secondary))
                        .lineLimit(1)
                }
                .padding(.horizontal, 4)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.pressableStatic)
            .accessibilityLabel("Account: \(label ?? "Auto")")
            .accessibilityHint(scope.sourceLine)
            .task(id: client.status.transport) {
                guard client.status.transport == .open else { return }
                await client.loadAccounts()
            }
            .onAppear {
                #if DEBUG
                if TestHooks.open == "account" { open = true }
                #endif
            }
            .sheet(isPresented: $open) {
                AccountMenu(client: client, session: session)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(Radius.sheet)
            }
        }
    }
}

/// The dot's colour: the profile's `#rrggbb` from Aliax, else tertiary.
enum AccountColor {
    static func of(_ name: String?, in accounts: ProviderAccounts?) -> Color {
        guard let name, let hex = accounts?.profiles.first(where: { $0.name == name })?.color, let color = Color(hex: hex) else {
            return Color(.tertiaryLabel)
        }
        return color
    }
}

extension Color {
    /// `#rrggbb` (or `rrggbb`); anything else is nil.
    init?(hex: String) {
        var text = Substring(hex)
        if text.hasPrefix("#") { text = text.dropFirst() }
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
