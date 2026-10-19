import SwiftUI
import TempCodeClient

/// Pair a host from its link, or add one from a key made on the desktop.
struct AddEnvironmentSheet: View {
    private enum Method: String, CaseIterable, Identifiable {
        case link = "Pairing link"
        case key = "Key"
        var id: String { rawValue }
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var method: Method = .link
    @State private var link = ""
    @State private var origin = ""
    @State private var key = ""
    @State private var name = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Picker("Method", selection: $method) {
                    ForEach(Method.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())

                Section {
                    switch method {
                    case .link:
                        TextField("https://host/pair#XXXXX-XXXXX", text: $link, axis: .vertical)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                    case .key:
                        TextField("https://host", text: $origin)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                        SecureField("tc_…", text: $key)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    TextField("Name (optional)", text: $name)
                } footer: {
                    if let error {
                        Text(error)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Add a host")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Add") { Task { await add() } }
                            .disabled(!canAdd)
                    }
                }
            }
            .interactiveDismissDisabled(busy)
        }
        .presentationDetents([.medium, .large])
    }

    private var canAdd: Bool {
        switch method {
        case .link: PairingLink(link) != nil
        case .key: URL(string: origin.trimmingCharacters(in: .whitespaces))?.host != nil && key.trimmingCharacters(in: .whitespaces).hasPrefix("tc_")
        }
    }

    private func add() async {
        busy = true
        error = nil
        defer { busy = false }
        let displayName = name.trimmingCharacters(in: .whitespaces)
        do {
            switch method {
            case .link:
                _ = try await model.registry.add(pairingLink: link, name: displayName.isEmpty ? nil : displayName)
            case .key:
                guard let url = URL(string: origin.trimmingCharacters(in: .whitespaces)) else { return }
                _ = try await model.registry.add(origin: url, key: key, name: displayName.isEmpty ? nil : displayName)
            }
            dismiss()
        } catch {
            self.error = error.message
        }
    }
}
