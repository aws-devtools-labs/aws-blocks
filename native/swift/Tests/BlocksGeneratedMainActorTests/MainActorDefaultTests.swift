//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import BlocksRuntime
import XCTest

/// Main-actor-isolated by default, like an app's view model.
private final class AppModel {
    let blocks = Blocks()
}

/// Main-actor-isolated by default, like a sign-in screen's model.
private final class SignInModel {
    var provider: Auth.GetClient.Provider = .github
}

private nonisolated struct RefusedLauncher: BrowserLauncher {
    func launch(authorizeURL: URL, callbackScheme: String) async throws -> URL {
        XCTFail("sign-in should fail before the browser opens")
        return authorizeURL
    }
}

/// Creates and closes its own `Blocks` off the main actor.
private actor Worker {
    let blocks = Blocks()

    func closeThenList() async -> Error? {
        blocks.close()
        do {
            _ = try await blocks.users.list()
            return nil
        } catch {
            return error
        }
    }
}

/// Drives the plugin's output under MainActor default isolation, as in Xcode 26 apps; nonisolated as XCTestCase's inits are.
final nonisolated class MainActorDefaultTests: XCTestCase {
    func testActorCreatesAndClosesBlocks() async {
        let error = await Worker().closeThenList()
        XCTAssertTrue(error is ClientClosedError, "\(String(describing: error))")
    }

    @MainActor
    func testDetachedTaskClosesMainActorBlocks() async {
        let blocks = AppModel().blocks
        await Task.detached { blocks.close() }.value
        do {
            _ = try await blocks.default.ping()
            XCTFail("expected ClientClosedError")
        } catch {
            XCTAssertTrue(error is ClientClosedError, "\(error)")
        }
    }

    @MainActor
    func testMainActorCodeSignsInWithAProviderEnum() async {
        // Port 9 refuses the connection, so sign-in fails on its first request.
        let blocks = Blocks(server: BlocksServer(name: "refused", url: "http://127.0.0.1:9/aws-blocks/api"))
        let oidc = OIDCClient<Auth.GetClient.Provider>(
            exchangePath: "/auth/exchange", refreshPath: "/auth/exchange/refresh", signOutPath: "/auth/signout",
            providers: ["github"], providerConfigs: [:], baseUrl: blocks.client.baseUrl, client: blocks.client
        )
        let model = SignInModel()
        do {
            _ = try await oidc.signIn(provider: model.provider, relayTo: "app://auth", launcher: RefusedLauncher())
            XCTFail("expected a connection error")
        } catch {
            XCTAssertTrue(error is URLError, "\(error)")
        }
    }

    func testNonisolatedCodeBuildsBlocksAndNamespaces() async {
        let blocks = Blocks(server: Servers.default, session: nil, tokenStore: InMemoryTokenStore())
        blocks.close()
        async let viaBlocks = blocks.users.list()
        async let viaNamespace = Users(client: blocks.client).list()
        let listed = await [try? viaBlocks, try? viaNamespace]
        XCTAssertEqual(listed, [nil, nil])
    }
}
