import SwiftUI
import TempCodeClient
import TempCodeContract

/// The Reviews section of the project settings sheet: the switch, and while
/// it is on the reviewer, its effort, what holds the merge and the time
/// limit. The section follows the global set until a field changes.
struct ReviewSettingsSection: View {
    let model: ProjectSettingsModel

    private var draft: ReviewDraft { model.review ?? ReviewDraft(scope: ReviewScope(override: nil, global: nil, settings: ReviewDraft.defaults, source: .default)) }

    var body: some View {
        Section {
            Toggle("Review before merge", isOn: Binding(
                get: { draft.beforeMerge },
                set: { on in withAnimation(Motion.expand) { edit { $0.beforeMerge = on } } }
            ))
            .accessibilityIdentifier("review-before-merge")
            if draft.beforeMerge {
                reviewerRow
                let ladder = Reviewers.ladder(provider: draft.provider, model: draft.model, catalog: model.catalog)
                if ladder.count > 1 {
                    // The saved level stays a choice even when the model's ladder lacks it.
                    let levels = ladder.contains(draft.reasoning) ? ladder : [draft.reasoning] + ladder
                    Picker("Reasoning", selection: field(\.reasoning)) {
                        ForEach(levels, id: \.rawValue) { level in
                            Text(level.label).tag(level)
                        }
                    }
                    .pickerStyle(.menu)
                }
                Picker("Hold the merge on", selection: field(\.blockOn)) {
                    Text("Confirmed defects").tag(ReviewSettings.BlockOn.confirmed)
                    Text("Any finding").tag(ReviewSettings.BlockOn.any)
                    if case .unknown(let word) = draft.blockOn {
                        Text(word).tag(draft.blockOn)
                    }
                }
                .pickerStyle(.menu)
                Picker("Time limit", selection: field(\.maxMinutes)) {
                    ForEach(Reviewers.minuteChoices(current: draft.maxMinutes), id: \.self) { minutes in
                        Text("\(minutes) min").tag(minutes)
                    }
                }
                .pickerStyle(.menu)
            }
            if !draft.follows {
                FollowRow { withAnimation(Motion.expand) { model.review?.useGlobal() } }
                    .accessibilityIdentifier("review-use-global")
            }
        } header: {
            Text("Reviews")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(SettingsCopy.reviewsFooter) \(SettingsCopy.source(follows: draft.follows, hasGlobal: draft.scope.global != nil))")
                if model.failed == .review, let error = model.saveError {
                    Text(error)
                        .foregroundStyle(Tint.destructive)
                        .rowAppearTransition()
                }
            }
        }
    }

    @ViewBuilder
    private var reviewerRow: some View {
        if let catalog = model.catalog {
            Picker("Reviewer", selection: Binding(
                get: { ModelKey(provider: draft.provider, model: draft.model) },
                set: { key in
                    edit { draft in
                        draft.provider = key.provider
                        draft.choose(model: key.model, ladder: Reviewers.ladder(provider: key.provider, model: key.model, catalog: catalog), defaultReasoning: Reviewers.defaultReasoning(provider: key.provider, model: key.model, catalog: catalog))
                    }
                }
            )) {
                let providers = Reviewers.providers.contains(draft.provider) ? Reviewers.providers : Reviewers.providers + [draft.provider]
                ForEach(providers, id: \.rawValue) { provider in
                    let options = Reviewers.options(provider: provider, catalog: catalog, rules: model.rules, current: provider == draft.provider ? draft.model : "")
                    if !options.isEmpty {
                        Section(catalog[provider.rawValue]?.label ?? (provider == .codex ? "Codex" : provider == .claude ? "Claude" : provider.rawValue)) {
                            ForEach(options, id: \.model) { option in
                                Text(option.label)
                                    .foregroundStyle(option.approved ? .primary : .secondary)
                                    .tag(ModelKey(provider: provider, model: option.model))
                            }
                        }
                    }
                }
            }
            .pickerStyle(.navigationLink)
            .accessibilityIdentifier("review-reviewer")
        } else {
            ValueRow(label: "Reviewer", value: Reviewers.modelLabel(provider: draft.provider, model: draft.model, catalog: nil), loading: true)
        }
    }

    /// A field's binding: every set leaves the global set.
    private func field<T: Hashable>(_ keyPath: WritableKeyPath<ReviewDraft, T> & Sendable) -> Binding<T> {
        Binding(get: { draft[keyPath: keyPath] }, set: { value in edit { $0[keyPath: keyPath] = value } })
    }

    private func edit(_ change: (inout ReviewDraft) -> Void) {
        guard var draft = model.review else { return }
        change(&draft)
        draft.touch()
        model.review = draft
    }
}
