import SwiftUI
import TempCodeClient
import TempCodeContract

/// One transcript: painted from the cache, live while the socket is up,
/// older rows when you reach the top.
struct ThreadView: View {
    let client: EnvironmentClient
    let sessionId: String
    @State private var pinnedToBottom = true

    var body: some View {
        let thread = client.threads[sessionId] ?? ThreadState()
        let items = Transcript.fold(thread.rows)
        VStack(spacing: 0) {
            StatusLine(client: client)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        if thread.moreBefore {
                            HStack {
                                Spacer()
                                if thread.isLoadingOlder {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Button("Earlier") { Task { await client.loadOlder(sessionId) } }
                                        .font(.footnote)
                                        .buttonStyle(.bordered)
                                        .controlSize(.small)
                                }
                                Spacer()
                            }
                            .padding(.top, 4)
                            .onAppear { Task { await client.loadOlder(sessionId) } }
                        }
                        if items.isEmpty && thread.isLoading {
                            HStack {
                                Spacer()
                                ProgressView()
                                Spacer()
                            }
                            .padding(.top, 40)
                        }
                        ForEach(items) { item in
                            TranscriptItemView(item: item, client: client, sessionId: sessionId)
                                .id(item.id)
                                .accessibilityIdentifier("transcript-item")
                        }
                        Color.clear
                            .frame(height: 1)
                            .id("bottom")
                            .onAppear { pinnedToBottom = true }
                            .onDisappear { pinnedToBottom = false }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: thread.rows.last?.seq) { _, _ in
                    guard pinnedToBottom else { return }
                    withAnimation(.spring(duration: 0.3, bounce: 0)) {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
            }
        }
        .animation(.default, value: client.status.transport)
        .navigationTitle(client.session(sessionId)?.title ?? "Thread")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(client.session(sessionId)?.title ?? "Thread")
                        .font(.headline)
                        .lineLimit(1)
                    if let activity = client.session(sessionId)?.activity, !activity.isEmpty {
                        Text(activity)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
        .task(id: sessionId) {
            await client.openThread(sessionId)
        }
        .onDisappear {
            client.closeThread(sessionId)
        }
    }
}
