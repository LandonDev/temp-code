import SwiftUI
import TempCodeClient
import TempCodeContract

// The pieces the composer, the cards and the sheets share: the catalog
// choice, the model and reasoning menus, the chip that opens them, and the
// full-width card button. Nothing here names a color or a duration of its
// own; every value comes from Tokens and Motion.

/// A provider and model as one choice in the catalog picker.
struct ModelKey: Hashable {
    var provider: ProviderId
    var model: String
}

/// The host's catalog as the composer and the sheets pick from it:
/// providers in the desktop's order with the models the host can run (the
/// host already hides what the installed CLI cannot), and the reasoning
/// levels of the chosen model. Loads once per client and keeps the choice
/// valid.
@Observable
final class CatalogChoice {
    var key: ModelKey
    var reasoning: Reasoning?
    private(set) var catalog: Catalog?
    private(set) var loading = false
    /// The person picked a model or a level: the choice stops following the thread until `follow`.
    private(set) var picked = false

    init(provider: ProviderId, model: String, reasoning: Reasoning?) {
        key = ModelKey(provider: provider, model: model)
        self.reasoning = reasoning
    }

    static let providerOrder: [ProviderId] = [.claude, .codex, .cursor, .grok, .opencode, .pi, .omp, .fx]

    /// Providers that have models, in the desktop's order.
    var providers: [ProviderInfo] {
        guard let catalog else { return [] }
        return Self.providerOrder.compactMap { catalog[$0.rawValue] }.filter { !$0.models.isEmpty }
            + catalog.values.filter { !Self.providerOrder.contains($0.id) && !$0.models.isEmpty }.sorted { $0.label < $1.label }
    }

    var model: ModelInfo? {
        catalog?[key.provider.rawValue]?.models.first { $0.id == key.model }
    }

    var levels: [Reasoning] { model?.reasoning ?? [] }

    /// The model's name as the chip and the row show it: the catalog's label, else the id read short.
    var modelLabel: String { model?.label ?? ModelName.short(key.model) }

    func load(_ client: EnvironmentClient) async {
        guard catalog == nil, !loading else { return }
        loading = true
        catalog = await client.loadCatalog()
        loading = false
        settle()
    }

    /// The choice stays on a model the host has; the reasoning on a level the model offers.
    func settle() {
        guard catalog != nil else { return }
        if model == nil, let first = providers.first {
            key = ModelKey(provider: first.id, model: first.defaultModel.isEmpty ? first.models[0].id : first.defaultModel)
        }
        if let reasoning, !levels.contains(reasoning) { self.reasoning = nil }
        if reasoning == nil { reasoning = model?.defaultReasoning ?? levels.first }
    }

    func choose(_ key: ModelKey) {
        self.key = key
        reasoning = nil
        picked = true
        settle()
    }

    func pick(_ level: Reasoning) {
        reasoning = level
        picked = true
    }

    /// Back onto a thread's own model, when the chips should follow it again.
    func follow(_ session: SessionMeta) {
        key = ModelKey(provider: session.provider, model: session.model)
        reasoning = session.reasoning
        picked = false
        settle()
    }
}

/// The model menu: one section per provider, the models as items, a check
/// on the current one. The label is the caller's (a chip, a row's value).
struct ModelMenu<Content: View>: View {
    @Bindable var choice: CatalogChoice
    @ViewBuilder let label: Content

    var body: some View {
        Menu {
            ForEach(choice.providers, id: \.id) { provider in
                Section(provider.label) {
                    ForEach(provider.models, id: \.id) { model in
                        let key = ModelKey(provider: provider.id, model: model.id)
                        Button {
                            choice.choose(key)
                        } label: {
                            if key == choice.key {
                                Label(model.label, systemImage: "checkmark")
                            } else {
                                Text(model.label)
                            }
                        }
                    }
                }
            }
        } label: {
            label
        }
        .menuOrder(.fixed)
    }
}

/// The reasoning menu: the chosen model's levels, a check on the current one.
struct ReasoningMenu<Content: View>: View {
    @Bindable var choice: CatalogChoice
    @ViewBuilder let label: Content

    var body: some View {
        Menu {
            ForEach(choice.levels, id: \.rawValue) { level in
                Button {
                    choice.pick(level)
                } label: {
                    if level == choice.reasoning {
                        Label(level.label, systemImage: "checkmark")
                    } else {
                        Text(level.label)
                    }
                }
            }
        } label: {
            label
        }
        .menuOrder(.fixed)
    }
}

/// A chip that opens a menu: the value in footnote medium, the up-down
/// chevron at the same weight, on the fill step with the row radius. The
/// chip's own press feedback is the menu's highlight; nothing scales twice.
struct MenuChip: View {
    let text: String
    var symbol: String? = nil
    var enabled = true

    var body: some View {
        HStack(spacing: 4) {
            if let symbol {
                Image(systemName: symbol)
                    .font(.caption2.weight(.medium))
            }
            Text(text)
                .lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
                .font(.caption2.weight(.medium))
                .opacity(enabled ? 1 : 0)
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(enabled ? Color.primary : Color.secondary)
        .padding(.horizontal, 8)
        .frame(height: 26)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
    }
}

/// A full-width action at the bottom of a card: the prominent one in the
/// accent with a white label, the quiet one on the fill step. Row radius
/// (the card's 12 less its 12 of padding leaves no room for more, so the
/// chip step is the next one down), 40 pt tall, the same press scale as
/// every button. A busy prominent button shows its spinner in place of the
/// label without changing size.
struct CardButton: View {
    enum Role { case prominent, quiet }

    let title: String
    let role: Role
    var busy = false
    let action: () -> Void

    init(_ title: String, role: Role, busy: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.role = role
        self.busy = busy
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            ZStack {
                Text(title)
                    .opacity(busy ? 0 : 1)
                if busy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(role == .prominent ? .white : .secondary)
                }
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(role == .prominent ? Color.white : Color.primary)
            .frame(maxWidth: .infinity)
            .frame(height: 40)
            .background(role == .prominent ? Color.accentColor : Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
        }
        .buttonStyle(.pressable)
        .animation(Motion.crossFade, value: busy)
    }
}

extension Reasoning {
    nonisolated var label: String {
        switch self {
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .xhigh: "Extra high"
        case .max: "Max"
        case .ultra: "Ultra"
        case .unknown(let value): value
        }
    }
}
