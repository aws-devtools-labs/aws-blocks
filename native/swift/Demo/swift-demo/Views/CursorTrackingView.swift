//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import SwiftUI
import BlocksRuntime

// MARK: - Cursor Tracking View
// Mirrors the "Realtime Cursors" section from the TypeScript demo (index.ts).
// Shows other users' cursors in real time via WebSocket channel.

struct CursorTrackingView: View {
    @EnvironmentObject var appState: AppState
    @StateObject private var viewModel = CursorTrackingViewModel()

    var body: some View {
        VStack(spacing: 0) {
            // Status bar
            HStack {
                Circle()
                    .fill(viewModel.isConnected ? Color.green : Color.red)
                    .frame(width: 8, height: 8)
                Text(viewModel.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Text("You: \(viewModel.userId)")
                    .font(.caption)
                    .foregroundStyle(Color(hex: viewModel.myColor))
            }
            .padding(.horizontal)
            .padding(.vertical, 8)

            // Tracking area
            GeometryReader { _ in
                ZStack {
                    // Background
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color(.systemGray6))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .strokeBorder(Color(.systemGray4), lineWidth: 1)
                        )

                    // Other users' cursors
                    ForEach(viewModel.remoteCursors) { cursor in
                        CursorView(cursor: cursor)
                    }

                    // Hint text when no cursors
                    if viewModel.remoteCursors.isEmpty {
                        Text("Drag here to broadcast your cursor.\nOther users' cursors appear in real time.")
                            .multilineTextAlignment(.center)
                            .font(.subheadline)
                            .foregroundStyle(.tertiary)
                    }
                }
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in
                            viewModel.publishCursor(
                                xPos: value.location.x,
                                yPos: value.location.y,
                                api: appState.api
                            )
                        }
                )
            }
            .padding()
        }
        .task {
            await viewModel.connect(api: appState.api)
        }
        .onDisappear {
            viewModel.disconnect()
        }
    }
}

// MARK: - Cursor View (single remote cursor)

struct CursorView: View {
    let cursor: RemoteCursor

    var body: some View {
        VStack(spacing: 2) {
            Image(systemName: "cursorarrow")
                .font(.title2)
                .foregroundStyle(Color(hex: cursor.color))
                .shadow(radius: 1)
            Text(cursor.userId)
                .font(.caption2)
                .padding(.horizontal, 4)
                .padding(.vertical, 2)
                .background(Color(hex: cursor.color).opacity(0.8))
                .foregroundStyle(.white)
                .clipShape(Capsule())
        }
        .position(x: cursor.xPos, y: cursor.yPos)
        .animation(.easeOut(duration: 0.1), value: cursor.xPos)
        .animation(.easeOut(duration: 0.1), value: cursor.yPos)
    }
}

// MARK: - View Model

@MainActor
final class CursorTrackingViewModel: ObservableObject {
    let userId = String(UUID().uuidString.prefix(6)).lowercased()
    let myColor: String

    @Published var remoteCursors: [RemoteCursor] = []
    @Published var isConnected = false
    @Published var statusText = "Connecting..."

    private var channel: RealtimeChannel<Cursor>?
    private var subscribeTask: Task<Void, Never>?
    private var lastPublish: Date = .distantPast
    private var lastSeen: [String: Date] = [:]
    private var staleTimer: Task<Void, Never>?

    private static let colors = ["#ff6b6b", "#4ecdc4", "#45b7d1", "#f9ca24", "#6c5ce7", "#a29bfe", "#fd79a8", "#00b894"]

    init() {
        self.myColor = Self.colors.randomElement()!
    }

    func connect(api: Api) async {
        do {
            let cursorChannel = try await api.getCursorChannel()
            channel = cursorChannel
            isConnected = true
            statusText = "Connected as \(userId)"

            // Start receiving cursor updates
            subscribeTask = Task {
                do {
                    for try await msg in cursorChannel.subscribe() {
                        guard msg.userId != userId else { continue }
                        await MainActor.run {
                            updateCursor(msg)
                        }
                    }
                } catch {
                    await MainActor.run {
                        isConnected = false
                        statusText = "Disconnected: \(error.localizedDescription)"
                    }
                }
            }

            // Start stale cursor cleanup (remove after 3s of inactivity)
            staleTimer = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                    await MainActor.run { removeStale() }
                }
            }
        } catch {
            isConnected = false
            statusText = "Error: \(error.localizedDescription)"
        }
    }

    func disconnect() {
        subscribeTask?.cancel()
        staleTimer?.cancel()
        channel?.close()
        channel = nil
        isConnected = false
    }

    func publishCursor(xPos: Double, yPos: Double, api: Api) {
        // Throttle to 50ms (same as the web app)
        let now = Date()
        guard now.timeIntervalSince(lastPublish) > 0.05 else { return }
        lastPublish = now

        let cursor = Cursor(color: myColor, userId: userId, x: xPos, y: yPos)
        Task {
            _ = try? await api.publishCursor(cursor: cursor)
        }
    }

    private func updateCursor(_ msg: Cursor) {
        lastSeen[msg.userId] = Date()

        if let idx = remoteCursors.firstIndex(where: { $0.userId == msg.userId }) {
            remoteCursors[idx].xPos = msg.x
            remoteCursors[idx].yPos = msg.y
            remoteCursors[idx].color = msg.color
        } else {
            remoteCursors.append(RemoteCursor(userId: msg.userId, xPos: msg.x, yPos: msg.y, color: msg.color))
        }
    }

    private func removeStale() {
        let now = Date()
        let staleIds = lastSeen.filter { now.timeIntervalSince($0.value) > 3 }.map(\.key)
        for id in staleIds {
            remoteCursors.removeAll { $0.userId == id }
            lastSeen.removeValue(forKey: id)
        }
    }
}

// MARK: - Remote Cursor Model

struct RemoteCursor: Identifiable {
    let id: String
    var userId: String
    var xPos: Double
    var yPos: Double
    var color: String

    init(userId: String, xPos: Double, yPos: Double, color: String) {
        self.id = userId
        self.userId = userId
        self.xPos = xPos
        self.yPos = yPos
        self.color = color
    }
}

// MARK: - Color from Hex

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let red = Double((int >> 16) & 0xff) / 255
        let green = Double((int >> 8) & 0xff) / 255
        let blue = Double(int & 0xff) / 255
        self.init(red: red, green: green, blue: blue)
    }
}
