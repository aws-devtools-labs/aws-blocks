//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
import Foundation
@testable import BlocksRuntime

/// Base class for E2E tests against test-apps/native-bindings.
/// Reads BLOCKS_URL from the environment (defaults to localhost dev server).
/// Each test runs on its own generated `Blocks`, closed in `tearDown`.
class BlocksE2ETestCase: XCTestCase {
    static let blocksUrl: String = ProcessInfo.processInfo.environment["BLOCKS_URL"]
            ?? "http://localhost:3001/aws-blocks/api"

    static let server: BlocksServer = .init(name: "e2e", url: blocksUrl)

    var blocks: Blocks!
    var api: Api!

    override func setUp() {
        super.setUp()
        BlocksClient.clearCookies()
        blocks = Blocks(server: Self.server)
        api = blocks.api
    }

    override func tearDown() {
        // Releases the session once in-flight requests finish; later calls throw ClientClosedError.
        blocks.close()
        super.tearDown()
    }
}
