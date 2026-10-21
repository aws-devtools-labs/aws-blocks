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

    func testNonisolatedCodeBuildsBlocksAndNamespaces() async {
        let blocks = Blocks(server: Servers.default, session: nil, tokenStore: InMemoryTokenStore())
        blocks.close()
        async let viaBlocks = blocks.users.list()
        async let viaNamespace = Users(client: blocks.client).list()
        let listed = await [try? viaBlocks, try? viaNamespace]
        XCTAssertEqual(listed, [nil, nil])
    }
}
