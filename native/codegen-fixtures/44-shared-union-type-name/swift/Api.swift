import Foundation
import BlocksRuntime

public final nonisolated class AlphaAuthApi: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.alphaAuthApi from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.local) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `alphaAuthApi.getAuthState`.
    public func getAuthState() async throws -> AuthState {
        let request = BlocksRequest(method: "alphaAuthApi.getAuthState", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for alphaAuthApi.getAuthState") }
        return try JSONDecoder().decode(AuthState.self, from: result)
    }

    /// Calls `alphaAuthApi.setAuthState`.
    public func setAuthState(input: AuthActionInput) async throws -> AuthState {
        let request = BlocksRequest(method: "alphaAuthApi.setAuthState", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for alphaAuthApi.setAuthState") }
        return try JSONDecoder().decode(AuthState.self, from: result)
    }

    public enum SetAuthState {

        @available(*, deprecated, message: "Use AuthActionInput")
        public typealias Input = AuthActionInput

        @available(*, deprecated, message: "Use AuthActionInput.SignUp")
        public typealias SignUp = AuthActionInput.SignUp

        @available(*, deprecated, message: "Use AuthActionInput.ResetPassword")
        public typealias ResetPassword = AuthActionInput.ResetPassword

        @available(*, deprecated, message: "Use AuthActionInput.SignIn")
        public typealias SignIn = AuthActionInput.SignIn

        @available(*, deprecated, message: "Use AuthActionInput.SignInWithPasskey")
        public typealias SignInWithPasskey = AuthActionInput.SignInWithPasskey

        @available(*, deprecated, message: "Use AuthActionInput.ConfirmSignUp")
        public typealias ConfirmSignUp = AuthActionInput.ConfirmSignUp

        @available(*, deprecated, message: "Use AuthActionInput.ResendSignUpCode")
        public typealias ResendSignUpCode = AuthActionInput.ResendSignUpCode

        @available(*, deprecated, message: "Use AuthActionInput.ConfirmResetPassword")
        public typealias ConfirmResetPassword = AuthActionInput.ConfirmResetPassword

        @available(*, deprecated, message: "Use AuthActionInput.AutoSignIn")
        public typealias AutoSignIn = AuthActionInput.AutoSignIn

        @available(*, deprecated, message: "Use AuthActionInput.ConfirmSignIn")
        public typealias ConfirmSignIn = AuthActionInput.ConfirmSignIn

        @available(*, deprecated, message: "Use AuthActionInput.CompletePasskeyRegistration")
        public typealias CompletePasskeyRegistration = AuthActionInput.CompletePasskeyRegistration

        @available(*, deprecated, message: "Use AuthActionInput.DeletePasskey")
        public typealias DeletePasskey = AuthActionInput.DeletePasskey

        @available(*, deprecated, message: "Use AuthActionInput.VerifyTotpSetup")
        public typealias VerifyTotpSetup = AuthActionInput.VerifyTotpSetup

        @available(*, deprecated, message: "Use AuthActionInput.UpdateMfaPreference")
        public typealias UpdateMfaPreference = AuthActionInput.UpdateMfaPreference
    }
}

public final nonisolated class ZetaAuthApi: Sendable {
    private let client: BlocksClient

    public init(client: BlocksClient) {
        self.client = client
    }

    @available(*, deprecated, message: "Use blocks.zetaAuthApi from one Blocks() or Blocks(server:) you hold")
    public convenience init(server: BlocksServer = Servers.local) {
        self.init(client: BlocksClient(server: server))
    }

    /// Calls `zetaAuthApi.getAuthState`.
    public func getAuthState() async throws -> AuthState {
        let request = BlocksRequest(method: "zetaAuthApi.getAuthState", params: [], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for zetaAuthApi.getAuthState") }
        return try JSONDecoder().decode(AuthState.self, from: result)
    }

    /// Calls `zetaAuthApi.setAuthState`.
    public func setAuthState(input: AuthActionInput) async throws -> AuthState {
        let request = BlocksRequest(method: "zetaAuthApi.setAuthState", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw TransportError(message: "Unexpected null result for zetaAuthApi.setAuthState") }
        return try JSONDecoder().decode(AuthState.self, from: result)
    }

    public enum SetAuthState {

        @available(*, deprecated, message: "Use AuthActionInput")
        public typealias Input = AuthActionInput

        @available(*, deprecated, message: "Use AuthActionInput.SignUp")
        public typealias SignUp = AuthActionInput.SignUp

        @available(*, deprecated, message: "Use AuthActionInput.ResetPassword")
        public typealias ResetPassword = AuthActionInput.ResetPassword

        @available(*, deprecated, message: "Use AuthActionInput.SignIn")
        public typealias SignIn = AuthActionInput.SignIn

        @available(*, deprecated, message: "Use AuthActionInput.SignInWithPasskey")
        public typealias SignInWithPasskey = AuthActionInput.SignInWithPasskey

        @available(*, deprecated, message: "Use AuthActionInput.ConfirmSignUp")
        public typealias ConfirmSignUp = AuthActionInput.ConfirmSignUp

        @available(*, deprecated, message: "Use AuthActionInput.ResendSignUpCode")
        public typealias ResendSignUpCode = AuthActionInput.ResendSignUpCode

        @available(*, deprecated, message: "Use AuthActionInput.ConfirmResetPassword")
        public typealias ConfirmResetPassword = AuthActionInput.ConfirmResetPassword

        @available(*, deprecated, message: "Use AuthActionInput.AutoSignIn")
        public typealias AutoSignIn = AuthActionInput.AutoSignIn

        @available(*, deprecated, message: "Use AuthActionInput.ConfirmSignIn")
        public typealias ConfirmSignIn = AuthActionInput.ConfirmSignIn

        @available(*, deprecated, message: "Use AuthActionInput.CompletePasskeyRegistration")
        public typealias CompletePasskeyRegistration = AuthActionInput.CompletePasskeyRegistration

        @available(*, deprecated, message: "Use AuthActionInput.DeletePasskey")
        public typealias DeletePasskey = AuthActionInput.DeletePasskey

        @available(*, deprecated, message: "Use AuthActionInput.VerifyTotpSetup")
        public typealias VerifyTotpSetup = AuthActionInput.VerifyTotpSetup

        @available(*, deprecated, message: "Use AuthActionInput.UpdateMfaPreference")
        public typealias UpdateMfaPreference = AuthActionInput.UpdateMfaPreference
    }
}


// MARK: - Blocks

/// One BlocksClient, so one URLSession (RPC and OIDC calls) and one token store, for every namespace in this spec;
/// file transfers and realtime use the shared runtime session. Hold one while the backend is in use: `let blocks = Blocks()`.
public final nonisolated class Blocks: Sendable {
    /// The server every API calls.
    public let server: BlocksRuntime.BlocksServer
    /// The client every API runs on.
    public let client: BlocksRuntime.BlocksClient

    public let alphaAuthApi: AlphaAuthApi
    public let zetaAuthApi: ZetaAuthApi

    /// Defaults to the spec's first server; a `session` you pass stays yours.
    public init(
        server: BlocksRuntime.BlocksServer = Servers.local,
        session: URLSession? = nil,
        tokenStore: any BlocksRuntime.TokenStore = BlocksRuntime.InMemoryTokenStore()
    ) {
        self.server = server
        self.client = BlocksRuntime.BlocksClient(server: server, session: session, tokenStore: tokenStore)
        self.alphaAuthApi = .init(client: client)
        self.zetaAuthApi = .init(client: client)
    }

    /// Later calls throw ClientClosedError; calls in flight finish, then the session this instance created is released.
    public func close() {
        client.close()
    }
}

// MARK: - Servers

public nonisolated enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/cdk-blocks/api")
}