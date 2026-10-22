import SwiftUI
import TempCodeClient
import TempCodeContract

/// The Plans section of the project settings sheet: auto-start, archive
/// after start, and the build's model, effort and context when one is
/// fixed. The section follows the global set until a field changes.
struct PlanSettingsSection: View {
    let model: ProjectSettingsModel

    private var draft: PlanDraft { model.plans ?? PlanDraft(scope: PlanScope(settings: PlanDraft.defaults, overridden: false), global: nil) }

    var body: some View {
        Section {
            Toggle("Start the build on its own", isOn: field(\.autoImplement))
                .accessibilityIdentifier("plans-auto-implement")
            Toggle("Archive the plan after start", isOn: field(\.archiveAfterStart))
            modelRow
            Picker("Build effort", selection: field(\.implementReasoning)) {
                Text(SettingsCopy.sameAsPlan).tag(PlanSettings.ImplementReasoning.none)
                let ladder = PlanBuild.ladder(model: draft.implementModel, catalog: model.catalog)
                ForEach(ladder, id: \.rawValue) { level in
                    Text(level.label).tag(PlanSettings.ImplementReasoning(rawValue: level.rawValue))
                }
                // A saved level off the model's ladder (or one this build does not know) stays a choice.
                if draft.implementReasoning != .none, !ladder.contains(where: { $0.rawValue == draft.implementReasoning.rawValue }) {
                    Text(Reasoning(rawValue: draft.implementReasoning.rawValue).label).tag(draft.implementReasoning)
                }
            }
            .pickerStyle(.menu)
            Picker("Build context", selection: field(\.implementContext)) {
                Text(SettingsCopy.sameAsPlan).tag(PlanSettings.ImplementContext.none)
                Text("1M").tag(PlanSettings.ImplementContext._1m)
                Text("200k").tag(PlanSettings.ImplementContext._200k)
                if case .unknown(let word) = draft.implementContext {
                    Text(word).tag(draft.implementContext)
                }
            }
            .pickerStyle(.menu)
            if !draft.follows {
                FollowRow { withAnimation(Motion.expand) { model.plans?.useGlobal() } }
                    .accessibilityIdentifier("plans-use-global")
            }
        } header: {
            Text("Plans")
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(SettingsCopy.plansFooter) \(SettingsCopy.source(follows: draft.follows, hasGlobal: draft.global != nil))")
                if model.failed == .plans, let error = model.saveError {
                    Text(error)
                        .foregroundStyle(Tint.destructive)
                        .rowAppearTransition()
                }
            }
        }
    }

    @ViewBuilder
    private var modelRow: some View {
        if let catalog = model.catalog {
            Picker("Build model", selection: Binding(
                get: { draft.implementModel },
                set: { id in edit { $0.choose(model: id, catalog: catalog) } }
            )) {
                Text(SettingsCopy.sameAsPlan).tag("")
                ForEach(PlanBuild.providers(catalog), id: \.id) { provider in
                    Section(provider.label) {
                        ForEach(provider.models, id: \.id) { info in
                            Text(info.label).tag(info.id)
                        }
                    }
                }
                let known = PlanBuild.providers(catalog).flatMap(\.models).map(\.id)
                if !draft.implementModel.isEmpty, !known.contains(draft.implementModel) {
                    Text(draft.implementModel).tag(draft.implementModel)
                }
            }
            .pickerStyle(.navigationLink)
            .accessibilityIdentifier("plans-build-model")
        } else {
            ValueRow(label: "Build model", value: draft.implementModel.isEmpty ? SettingsCopy.sameAsPlan : draft.implementModel, loading: true)
        }
    }

    /// A field's binding: every set leaves the global set.
    private func field<T: Hashable>(_ keyPath: WritableKeyPath<PlanDraft, T> & Sendable) -> Binding<T> {
        Binding(get: { draft[keyPath: keyPath] }, set: { value in edit { $0[keyPath: keyPath] = value } })
    }

    private func edit(_ change: (inout PlanDraft) -> Void) {
        guard var draft = model.plans else { return }
        change(&draft)
        draft.touch()
        model.plans = draft
    }
}
