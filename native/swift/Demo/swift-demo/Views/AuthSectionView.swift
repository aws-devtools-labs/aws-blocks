//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import SwiftUI

struct AuthSectionView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        List {
            // Status
            Section {
                if let user = appState.currentUser {
                    Label("Logged in as: \(user.username)", systemImage: "person.fill")
                        .foregroundStyle(.green)
                } else {
                    Label("Not logged in", systemImage: "person.slash")
                        .foregroundStyle(.secondary)
                }
            }

            // Error
            if let error = appState.error {
                Section {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }

            // Dynamic action forms
            if let actions = appState.authState?.actions {
                ForEach(actions, id: \.name) { action in
                    Section(action.label) {
                        AuthActionFormView(action: action)
                    }
                }
            }
        }
    }
}

// MARK: - Dynamic Auth Action Form

struct AuthActionFormView: View {
    @EnvironmentObject var appState: AppState
    let action: AuthAction

    @State private var fieldValues: [String: String] = [:]
    @State private var isLoading = false

    var body: some View {
        ForEach(action.fields, id: \.name) { field in
            if field.type != .hidden {
                if field.type == .password {
                    SecureField(field.label, text: binding(for: field))
                        .textContentType(.password)
                } else {
                    TextField(field.label, text: binding(for: field))
                        .textContentType(contentType(for: field))
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                }
            }
        }

        Button {
            Task { await submit() }
        } label: {
            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity)
            } else {
                Text(action.label)
                    .frame(maxWidth: .infinity)
            }
        }
        .buttonStyle(.borderedProminent)
        .disabled(isLoading)
        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
        .onAppear {
            for field in action.fields {
                if let defaultValue = field.defaultValue {
                    fieldValues[field.name] = defaultValue
                }
            }
        }
    }

    private func binding(for field: AuthField) -> Binding<String> {
        Binding(
            get: { fieldValues[field.name] ?? field.defaultValue ?? "" },
            set: { fieldValues[field.name] = $0 }
        )
    }

    private func contentType(for field: AuthField) -> UITextContentType? {
        switch field.type {
        case .email: return .emailAddress
        case .tel: return .telephoneNumber
        case .password: return .password
        default: return nil
        }
    }

    private func submit() async {
        isLoading = true
        defer { isLoading = false }

        let input = buildInput()
        guard let input else { return }
        await appState.performAuthAction(input)
    }

    private func buildInput() -> AuthApi.SetAuthState.Input? {
        let username = fieldValues["username"] ?? ""
        let password = fieldValues["password"] ?? ""
        let code = fieldValues["code"] ?? ""
        let newPassword = fieldValues["newPassword"] ?? ""

        switch action.name {
        case "signIn":
            return .signIn(AuthApi.SetAuthState.SignIn(password: password, username: username))
        case "signUp":
            return .signUp(AuthApi.SetAuthState.SignUp(password: password, username: username, attributes: [:]))
        case "confirmSignUp":
            return .confirmSignUp(
                AuthApi.SetAuthState.ConfirmSignUp(code: code, password: password, username: username)
            )
        case "signOut":
            return .signOut
        case "resetPassword":
            return .resetPassword(AuthApi.SetAuthState.ResetPassword(username: username))
        case "confirmResetPassword":
            return .confirmResetPassword(
                AuthApi.SetAuthState.ConfirmResetPassword(code: code, newPassword: newPassword, username: username)
            )
        default:
            return nil
        }
    }
}
