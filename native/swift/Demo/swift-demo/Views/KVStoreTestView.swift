//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import SwiftUI

struct KVStoreTestView: View {
    @EnvironmentObject var appState: AppState

    @State private var key = "test-key"
    @State private var value = "test-value"
    @State private var result: ResultMessage?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Key", text: $key)
                .textFieldStyle(.roundedBorder)
                .autocapitalization(.none)
                .disableAutocorrection(true)

            TextField("Value", text: $value)
                .textFieldStyle(.roundedBorder)
                .autocapitalization(.none)
                .disableAutocorrection(true)

            HStack {
                Button("Set Value") { Task { await setValue() } }
                    .buttonStyle(.borderedProminent)
                Button("Get Value") { Task { await getValue() } }
                    .buttonStyle(.bordered)
            }

            if let result {
                Text(result.text)
                    .font(.caption)
                    .foregroundStyle(result.isError ? .red : .green)
            }
        }
    }

    private func setValue() async {
        do {
            _ = try await appState.api.setValue(key: key, value: value)
            result = ResultMessage(text: "✓ Set \(key) = \(value)", isError: false)
        } catch {
            result = ResultMessage(text: "✗ \(error.localizedDescription)", isError: true)
        }
    }

    private func getValue() async {
        do {
            if let val = try await appState.api.getValue(key: key) {
                result = ResultMessage(text: "✓ Got value: \(val)", isError: false)
            } else {
                result = ResultMessage(text: "✗ Key not found", isError: true)
            }
        } catch {
            result = ResultMessage(text: "✗ \(error.localizedDescription)", isError: true)
        }
    }
}
