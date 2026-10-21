import SwiftUI
import TempCodeClient

/// Pair a host from its link, or add one from a key made on the desktop. A
/// medium sheet with the system's 16 pt radius: the method on top, the
/// field, a refusal under the field in destructive (never an alert), and
/// a successful pairing dismisses with the host already in the list.
struct AddEnvironmentSheet: View {
    /// Pairing again: the host whose key is replaced; the sheet keeps its name and address.
    var replacing: PairedEnvironment? = nil

    private enum Method: String, CaseIterable, Identifiable {
        case link = "Pairing Link"
        case key = "Key"
        var id: String { rawValue }
    }

    private enum Field: Hashable {
        case link
        case origin
        case key
        case name
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focus: Field?
    @State private var method: Method = .link
    @State private var link = ""
    @State private var origin = ""
    @State private var key = ""
    @State private var name = ""
    @State private var error: String?
    @State private var busy = false
    /// Tick once per outcome for the haptic.
    @State private var successes = 0
    @State private var refusals = 0

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Method", selection: $method) {
                        ForEach(Method.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                    .accessibilityIdentifier("pair-method")
                }

                Section {
                    switch method {
                    case .link:
                        HStack(alignment: .top, spacing: 12) {
                            TextField("https://host/pair#XXXXX-XXXXX", text: $link)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .keyboardType(.URL)
                                .textContentType(.URL)
                                .submitLabel(.go)
                                .focused($focus, equals: .link)
                                .onSubmit { submit() }
                                .accessibilityIdentifier("pair-link")
                            if link.isEmpty {
                                PasteButton(payloadType: String.self) { strings in
                                    MainActor.assumeIsolated {
                                        guard let text = strings.first else { return }
                                        link = text
                                        // A pasted link that reads cleanly is redeemed at once.
                                        if PairingLink(text) != nil { submit() }
                                    }
                                }
                                .labelStyle(.iconOnly)
                                .buttonBorderShape(.capsule)
                                .controlSize(.small)
                                .transition(.opacity)
                            }
                        }
                        .animation(Motion.crossFade, value: link.isEmpty)
                    case .key:
                        TextField("https://host", text: $origin)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .submitLabel(.next)
                            .focused($focus, equals: .origin)
                            .onSubmit { focus = .key }
                            .accessibilityIdentifier("pair-origin")
                        SecureField("tc_…", text: $key)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.go)
                            .focused($focus, equals: .key)
                            .onSubmit { submit() }
                            .accessibilityIdentifier("pair-key")
                    }
                    if let error {
                        InlineFieldError(message: error)
                            .transition(Motion.appear(reduced: reduceMotion))
                    }
                } footer: {
                    Text(hint)
                        .contentTransition(.opacity)
                        .animation(Motion.crossFade, value: hint)
                }

                Section {
                    TextField("Name", text: $name)
                        .submitLabel(.go)
                        .focused($focus, equals: .name)
                        .onSubmit { submit() }
                        .accessibilityIdentifier("pair-name")
                } footer: {
                    Text(replacing == nil ? "Optional. The host's own name when left empty." : "Replaces the key for \u{201C}\(replacing?.name ?? "")\u{201D}; the name and address stay.")
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(replacing == nil ? "Add a Host" : "Pair Again")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    ZStack {
                        Button(replacing == nil ? "Add" : "Pair") { submit() }
                            .fontWeight(.semibold)
                            .disabled(!canAdd || busy)
                            .opacity(busy ? 0 : 1)
                            .accessibilityIdentifier("pair-submit")
                        ProgressView()
                            .opacity(busy ? 1 : 0)
                            .accessibilityHidden(!busy)
                    }
                    .animation(Motion.crossFade, value: busy)
                }
            }
            .interactiveDismissDisabled(busy)
            .onChange(of: method) { _, _ in
                withAnimation(Motion.rowLeave) { error = nil }
                focus = method == .link ? .link : .origin
            }
            .onChange(of: link) { _, _ in clearErrorIfTyping() }
            .onChange(of: key) { _, _ in clearErrorIfTyping() }
            .onChange(of: origin) { _, _ in clearErrorIfTyping() }
        }
        .presentationDetents([.medium, .large])
        .presentationCornerRadius(Radius.sheet)
        .presentationDragIndicator(.visible)
        .sensoryFeedback(.success, trigger: successes)
        .sensoryFeedback(.error, trigger: refusals)
        .task {
            if let replacing {
                name = replacing.name
                origin = replacing.origin.absoluteString
            }
            #if DEBUG
            // The proof's refused pairing: the test server's origin with a code it never made.
            if TestHooks.sheet == "pair-error",
               let real = ProcessInfo.processInfo.environment["TC_TEST_PAIR_LINK"],
               let parsed = PairingLink(real) {
                link = "\(parsed.origin.absoluteString)/pair#AAAAA-BBBBB"
                submit()
                return
            }
            #endif
            // The first field takes the keyboard once the sheet has settled.
            try? await Task.sleep(for: .milliseconds(350))
            if focus == nil { focus = method == .link ? .link : .origin }
        }
    }

    private var canAdd: Bool {
        switch method {
        case .link: PairingLink(link) != nil
        case .key: URL(string: origin.trimmingCharacters(in: .whitespaces))?.host != nil && key.trimmingCharacters(in: .whitespaces).hasPrefix("tc_")
        }
    }

    /// Under the field: what the sheet recognised, or how to get a link.
    private var hint: String {
        switch method {
        case .link:
            if let parsed = PairingLink(link) {
                return "Pairs with \(parsed.origin.host ?? parsed.origin.absoluteString)."
            }
            return link.isEmpty
                ? "Make a link in the host's Settings → Remote access, then paste it here."
                : "A pairing link looks like https://host/pair#XXXXX-XXXXX."
        case .key:
            return "A key made in the host's Remote access pane, with the host's address."
        }
    }

    private func clearErrorIfTyping() {
        guard error != nil else { return }
        withAnimation(Motion.rowLeave) { error = nil }
    }

    private func submit() {
        guard canAdd, !busy else { return }
        Task { await add() }
    }

    private func add() async {
        busy = true
        withAnimation(Motion.rowLeave) { error = nil }
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
            successes += 1
            dismiss()
        } catch {
            refusals += 1
            withAnimation(Motion.rowAppear) { self.error = sentence(error.message) }
        }
    }
}
