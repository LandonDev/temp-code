import SwiftUI
import TempCodeClient
import TempCodeContract

/// One Mac's simulators and iPhones, as `client` (that Mac, or a box linked
/// to it) reports them: a state dot, the runtime and state with a booted
/// one's CPU rolling, and who holds each, pushing that thread when its host
/// is paired here. Shut Down and Delete (confirmed, naming the holder) on a
/// swipe and in the context menu, Open in Xcode on a phone's; an operate key
/// acts, a lesser one reads why in the footer. The watch itself runs in
/// `ActivityPollers`, so the section's rows can change freely.
struct MacDevicesSection: View {
    let client: EnvironmentClient
    let host: HostDevicesHost
    @Environment(AppModel.self) private var model
    @State private var deleting: Simulator?
    @State private var actionError: String?
    @State private var painted = false

    var body: some View {
        let state = client.extras.devices[host.environmentId]
        let canAct = HostExtrasAccess.deviceActions.allowed(client.environment) && client.status.transport == .open
        Section {
            if let report = state?.report {
                let ids = report.simulators.map(\.udid) + report.phones.map(\.udid)
                if ids.isEmpty {
                    Text("No simulators")
                        .foregroundStyle(.tertiary)
                }
                Group {
                    ForEach(report.simulators, id: \.udid) { sim in
                        simulatorRow(sim, busy: state?.busy == sim.udid, canAct: canAct)
                    }
                    ForEach(report.phones, id: \.udid) { phone in
                        phoneRow(phone, canAct: canAct)
                    }
                }
                .animation(painted ? Motion.rowAppear : nil, value: ids)
                .onAppear { painted = true }
            } else if let error = state?.error {
                Text(error)
                    .textStep(.meta, tint: Tint.destructive)
            } else {
                LookingRow()
            }
            RowErrorLine(message: $actionError)
        } header: {
            Text(host.local ? "Devices" : "Devices on \(host.name)")
        } footer: {
            if let report = state?.report {
                FooterText(lines: footer(report))
            }
        }
    }

    private func footer(_ report: HostDevicesReport) -> [String] {
        var lines = [DeviceWords.summary(report), DeviceWords.xcodeLine(report.xcode)]
        lines += report.problems
        if !HostExtrasAccess.deviceActions.allowed(client.environment) { lines.append(HostExtrasAccess.deviceActions.reason) }
        return lines
    }

    @ViewBuilder
    private func simulatorRow(_ sim: Simulator, busy: Bool, canAct: Bool) -> some View {
        DeviceRow(name: sim.name, state: DeviceWords.simulatorState(sim), busy: busy, holder: sim.holder, route: route(for: sim.holder))
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button("Delete", systemImage: "trash") { deleting = sim }
                    .tint(Tint.destructive)
                    .disabled(!canAct)
                if sim.state == .booted {
                    Button("Shut Down", systemImage: "power") { shutDown(sim) }
                        .disabled(!canAct)
                }
            }
            .contextMenu {
                if sim.state == .booted {
                    Button("Shut Down", systemImage: "power") { shutDown(sim) }
                        .disabled(!canAct)
                }
                Button("Delete", systemImage: "trash", role: .destructive) { deleting = sim }
                    .disabled(!canAct)
            }
            // On the row it confirms: a header scrolls away and takes its alert with it.
            .alert(
                DeviceWords.deleteConfirm(sim).title,
                isPresented: Binding(get: { deleting?.udid == sim.udid }, set: { if !$0 { deleting = nil } })
            ) {
                Button("Cancel", role: .cancel) {}
                Button("Delete", role: .destructive) { act { try await $0.deleteSimulator(mac: host.environmentId, udid: sim.udid) } }
            } message: {
                Text(DeviceWords.deleteConfirm(sim).body)
            }
            .rowAppearTransition()
    }

    @ViewBuilder
    private func phoneRow(_ phone: Phone, canAct: Bool) -> some View {
        DeviceRow(name: phone.name, state: DeviceWords.phoneState(phone), busy: false, holder: phone.holder, route: route(for: phone.holder))
            .contextMenu {
                Button("Open in Xcode", systemImage: "hammer") {
                    act { try await $0.openXcode(mac: host.environmentId) }
                }
                .disabled(!canAct)
            }
            .rowAppearTransition()
    }

    /// The holder's thread, when its host is paired here (absent host: the answering one).
    private func route(for holder: DeviceHolder?) -> Route? {
        guard let holder else { return nil }
        let hostId = holder.environmentId ?? client.environment.id
        guard model.registry.client(hostId) != nil else { return nil }
        return .thread(environmentId: hostId, sessionId: holder.sessionId, seq: nil)
    }

    private func shutDown(_ sim: Simulator) {
        act { try await $0.shutdownSimulator(mac: host.environmentId, udid: sim.udid) }
    }

    private func act(_ body: @escaping @MainActor (HostExtras) async throws -> Void) {
        let extras = client.extras
        Task { @MainActor in
            do {
                try await body(extras)
            } catch {
                withAnimation(Motion.rowAppear) { actionError = (error as? ActionError)?.message ?? error.localizedDescription }
            }
        }
    }
}

/// A device: the dot (a spinner while an action is out for it), the name,
/// the state line in the meta step, and who holds it trailing in the
/// footnote's tertiary; a row whose holder is reachable pushes that thread.
struct DeviceRow: View {
    let name: String
    let state: DeviceState
    let busy: Bool
    let holder: DeviceHolder?
    let route: Route?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if let route {
            NavigationLink(value: route) { content }
        } else {
            content
        }
    }

    private var content: some View {
        HStack(spacing: Layout.rowGap) {
            MarkColumn(key: busy) {
                if busy {
                    ProgressView().controlSize(.mini)
                } else {
                    DeviceDot(tone: state.tone)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .lineLimit(1)
                Text(state.text)
                    .textStep(.meta)
                    .lineLimit(1)
                    .numeric(state.text)
                // Stacked at accessibility sizes: trailing, the holder was squeezed to a letter.
                if typeSize.isAccessibilitySize { holderText }
            }
            .layoutPriority(1)
            Spacer(minLength: Layout.rowGap)
            if !typeSize.isAccessibilitySize { holderText }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityValue(state.text)
    }

    private var holderText: some View {
        Text(holder.map(DeviceWords.holder) ?? "—")
            .font(.footnote)
            .foregroundStyle(.tertiary)
            .lineLimit(1)
            .truncationMode(.tail)
    }
}
