//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import SwiftUI

struct RunAllTestsView: View {
    @EnvironmentObject var appState: AppState

    @State private var results: [ResultMessage] = []
    @State private var isRunning = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                Task { await runAll() }
            } label: {
                if isRunning {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else {
                    Text("Run All Tests")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isRunning)

            ForEach(Array(results.enumerated()), id: \.offset) { _, msg in
                Text(msg.text)
                    .font(.caption)
                    .foregroundStyle(msg.isError ? .red : .green)
            }
        }
    }

    private func runAll() async {
        isRunning = true
        defer { isRunning = false }
        results = []

        let api = appState.api

        // KV Store test
        do {
            _ = try await api.setValue(key: "test1", value: "value1")
            let val = try await api.getValue(key: "test1")
            results.append(ResultMessage(
                text: val == "value1" ? "✓ KV Store works" : "✗ KV Store failed",
                isError: val != "value1"
            ))
        } catch {
            results.append(ResultMessage(text: "✗ KV Store: \(error.localizedDescription)", isError: true))
        }

        // Cookie set/get test
        do {
            _ = try await api.setCookie(name: "testCookie", value: "testValue")
            let cookie = try await api.getCookie(name: "testCookie")
            results.append(ResultMessage(
                text: cookie == "testValue" ? "✓ Cookie set/get works" : "✗ Cookie set/get failed",
                isError: cookie != "testValue"
            ))
        } catch {
            results.append(ResultMessage(text: "✗ Cookie set/get: \(error.localizedDescription)", isError: true))
        }

        // Cookie delete test
        do {
            _ = try await api.deleteCookie(name: "testCookie")
            let deleted = try await api.getCookie(name: "testCookie")
            results.append(ResultMessage(
                text: deleted == nil ? "✓ Cookie delete works" : "✗ Cookie delete failed",
                isError: deleted != nil
            ))
        } catch {
            results.append(ResultMessage(text: "✗ Cookie delete: \(error.localizedDescription)", isError: true))
        }
    }
}
