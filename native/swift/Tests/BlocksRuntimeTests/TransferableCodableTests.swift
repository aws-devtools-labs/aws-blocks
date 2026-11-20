//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

/// Transferables decode from their wire descriptor through `Codable`, so a generated model can hold one at any
/// depth (a field, an array, a dictionary, an optional, a nested model), and encode back to the descriptor the
/// server sent (the TypeScript `toJSON()` form).
final class TransferableCodableTests: XCTestCase {

    private struct Note: Codable, Equatable {
        let id: String
        let body: String
    }

    private struct Inner: Codable {
        let feed: RealtimeChannel<Note>
    }

    private struct Board: Codable {
        let channel: RealtimeChannel<Note>
        let channels: [RealtimeChannel<Note>]
        let byRoom: [String: RealtimeChannel<[String]>]
        let maybe: RealtimeChannel<Note>?
        let missing: RealtimeChannel<Note>?
        let inner: Inner
        let downloads: [FileDownloadHandle]
        let upload: FileUploadHandle?
    }

    private struct SignInOption: Codable {
        let label: String
        let client: OIDCClient<String>
    }

    private struct LoginMenu: Codable {
        let primary: SignInOption
        let options: [SignInOption]
        let fallback: OIDCClient<String>?
    }

    private static let channelJSON = """
    {"__blocks":"realtime/channel","channel":"app/notes","wsUrl":"ws://localhost:3001/ws",\
    "connectToken":"ct","token":"tok"}
    """

    private static let oidcJSON = """
    {"__blocks":"oidc/client","providers":["google"],"exchangePath":"/auth/exchange","signOutPath":"/auth/signout",\
    "providerConfigs":{"google":{"authorizeUrl":"https://idp.example/auth","clientId":"cid","scopes":["openid"],\
    "kind":"oidc-builtin"}},"signInBasePath":"/auth/signin"}
    """

    private var savedBaseHost = BlocksClient.baseHost

    override func setUp() {
        super.setUp()
        savedBaseHost = BlocksClient.baseHost
    }

    override func tearDown() {
        BlocksClient.baseHost = savedBaseHost
        super.tearDown()
    }

    private func object(_ data: Data) throws -> NSDictionary {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    // MARK: - RealtimeChannel

    func testChannelDecodesLikeFromJSON() throws {
        let channel = try JSONDecoder().decode(RealtimeChannel<Note>.self, from: Data(Self.channelJSON.utf8))
        let hydrated = RealtimeChannel<Note>.fromJSON(
            try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(Self.channelJSON.utf8)) as? [String: Any]),
            baseHost: BlocksClient.baseHost
        ) { try JSONDecoder().decode(Note.self, from: $0) }

        XCTAssertEqual(channel.channel, "app/notes")
        XCTAssertEqual(channel.token, "tok")
        XCTAssertEqual(channel.wsUrl, "ws://localhost:3001/ws?token=ct")
        XCTAssertEqual(channel.wsUrl, hydrated.wsUrl)
    }

    func testChannelDecodeRewritesLocalhostWithBaseHost() throws {
        BlocksClient.baseHost = "192.168.1.5"
        let channel = try JSONDecoder().decode(RealtimeChannel<Note>.self, from: Data(Self.channelJSON.utf8))
        XCTAssertEqual(channel.wsUrl, "ws://192.168.1.5:3001/ws?token=ct")
    }

    func testDecodedChannelDeserializesTypedMessages() throws {
        let channel = try JSONDecoder().decode(RealtimeChannel<Note>.self, from: Data(Self.channelJSON.utf8))
        let note = try channel.deserializer(Data(#"{"id":"1","body":"hi"}"#.utf8))
        XCTAssertEqual(note, Note(id: "1", body: "hi"))
    }

    /// Transferables are read-only: encoding one, decoded or built with `init`, throws.
    func testEncodingAChannelThrows() throws {
        let decoded = try JSONDecoder().decode(RealtimeChannel<Note>.self, from: Data(Self.channelJSON.utf8))
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(Self.channelJSON.utf8)) as? [String: Any])
        let hydrated = RealtimeChannel<Note>.fromJSON(json) { try JSONDecoder().decode(Note.self, from: $0) }
        let constructed = RealtimeChannel<Note>(channel: "c", wsUrl: "wss://x/ws", token: "t") { _ in Note(id: "", body: "") }
        for channel in [decoded, hydrated, constructed] {
            assertReadOnly(channel, tag: "realtime/channel")
        }
    }

    func testChannelDecodeRejectsAnotherTransferable() {
        let json = #"{"__blocks":"file-bucket/download","channel":"c","wsUrl":"ws://x","token":"t"}"#
        XCTAssertThrowsError(try JSONDecoder().decode(RealtimeChannel<Note>.self, from: Data(json.utf8))) { error in
            XCTAssertTrue(error is DecodingError, "\(error)")
        }
    }

    func testChannelDecodeThrowsOnAMissingField() {
        // `fromJSON` traps on a bad descriptor; decoding throws, so a model decode can fail normally.
        let json = #"{"__blocks":"realtime/channel","channel":"c","token":"t"}"#
        XCTAssertThrowsError(try JSONDecoder().decode(RealtimeChannel<Note>.self, from: Data(json.utf8))) { error in
            XCTAssertTrue(error is DecodingError, "\(error)")
        }
    }

    // MARK: - File handles

    func testFileHandlesDecodeAndRefuseToEncode() throws {
        let download = #"{"__blocks":"file-bucket/download","url":"https://s3/get"}"#
        let upload = #"{"__blocks":"file-bucket/upload","url":"https://s3/put","contentType":"image/png"}"#
        let bareUpload = #"{"__blocks":"file-bucket/upload","url":"https://s3/put"}"#

        let downloadHandle = try JSONDecoder().decode(FileDownloadHandle.self, from: Data(download.utf8))
        let uploadHandle = try JSONDecoder().decode(FileUploadHandle.self, from: Data(upload.utf8))
        let bareUploadHandle = try JSONDecoder().decode(FileUploadHandle.self, from: Data(bareUpload.utf8))

        XCTAssertEqual(downloadHandle.getUrl(), "https://s3/get")
        XCTAssertEqual(uploadHandle.getUrl(), "https://s3/put")
        XCTAssertEqual(bareUploadHandle.getUrl(), "https://s3/put")
        assertReadOnly(downloadHandle, tag: "file-bucket/download")
        assertReadOnly(uploadHandle, tag: "file-bucket/upload")
    }

    func testFileHandleDecodeThrowsWithoutAURLOrForAnotherTransferable() {
        XCTAssertThrowsError(
            try JSONDecoder().decode(FileDownloadHandle.self, from: Data(#"{"__blocks":"file-bucket/download"}"#.utf8))
        )
        XCTAssertThrowsError(
            try JSONDecoder().decode(FileDownloadHandle.self, from: Data(#"{"__blocks":"file-bucket/upload","url":"u"}"#.utf8))
        )
    }

    // MARK: - Containers and nested models

    func testModelHoldingTransferablesAtAnyDepthDecodes() throws {
        let channel = Self.channelJSON
        let json = """
        {"channel":\(channel),"channels":[\(channel),\(channel)],"byRoom":{"a":\(channel)},"maybe":\(channel),\
        "inner":{"feed":\(channel)},"downloads":[{"__blocks":"file-bucket/download","url":"https://s3/get"}],\
        "upload":{"__blocks":"file-bucket/upload","url":"https://s3/put"}}
        """
        let board = try JSONDecoder().decode(Board.self, from: Data(json.utf8))

        XCTAssertEqual(board.channels.count, 2)
        XCTAssertEqual(board.byRoom["a"]?.channel, "app/notes")
        XCTAssertEqual(try board.byRoom["a"]?.deserializer(Data(#"["x","y"]"#.utf8)), ["x", "y"])
        XCTAssertEqual(board.maybe?.token, "tok")
        XCTAssertNil(board.missing)
        XCTAssertEqual(board.inner.feed.wsUrl, "ws://localhost:3001/ws?token=ct")
        XCTAssertEqual(board.downloads.first?.getUrl(), "https://s3/get")
        XCTAssertEqual(board.upload?.getUrl(), "https://s3/put")
        assertReadOnly(board, tag: "realtime/channel")
    }

    // MARK: - OIDCClient

    func testOIDCClientDecodesWithTheClientFromUserInfo() throws {
        let client = BlocksClient(url: "http://localhost:3001/cdk-blocks/api")
        let oidc = try client.makeDecoder().decode(OIDCClient<String>.self, from: Data(Self.oidcJSON.utf8))

        XCTAssertEqual(oidc.providers, ["google"])
        XCTAssertEqual(oidc.exchangePath, "/auth/exchange")
        XCTAssertEqual(oidc.refreshPath, "/auth/exchange/refresh")
        XCTAssertEqual(oidc.signOutPath, "/auth/signout")
        XCTAssertEqual(oidc.providerConfigs["google"]?.clientId, "cid")
        XCTAssertEqual(oidc.baseUrl, "http://localhost:3001/cdk-blocks/api")
        XCTAssertTrue(oidc.client === client)
    }

    func testMakeDecoderCarriesTheClient() {
        let client = BlocksClient(url: "http://localhost:3001/cdk-blocks/api")
        XCTAssertTrue(client.makeDecoder().userInfo[.blocksClient] as? BlocksClient === client)
    }

    func testOIDCClientDecodeWithoutAClientThrows() {
        XCTAssertThrowsError(try JSONDecoder().decode(OIDCClient<String>.self, from: Data(Self.oidcJSON.utf8))) { error in
            guard case DecodingError.dataCorrupted(let context) = error else {
                return XCTFail("Expected dataCorrupted, got \(error)")
            }
            XCTAssertTrue(context.debugDescription.contains("blocksClient"), context.debugDescription)
        }
    }

    func testEncodingAnOIDCClientThrows() throws {
        let client = BlocksClient(url: "http://localhost:3001/cdk-blocks/api")
        let decoded = try client.makeDecoder().decode(OIDCClient<String>.self, from: Data(Self.oidcJSON.utf8))
        let constructed = OIDCClient<String>(
            exchangePath: "/e", refreshPath: "/r", signOutPath: "/s", providers: ["p"],
            providerConfigs: [:], baseUrl: "http://h", client: BlocksClient(url: "http://h")
        )
        assertReadOnly(decoded, tag: "oidc/client")
        assertReadOnly(constructed, tag: "oidc/client")
    }

    func testOIDCClientsInNestedModelsAndArraysDecode() throws {
        let client = BlocksClient(url: "http://localhost:3001/cdk-blocks/api")
        let json = """
        {"primary":{"label":"Google","client":\(Self.oidcJSON)},\
        "options":[{"label":"A","client":\(Self.oidcJSON)},{"label":"B","client":\(Self.oidcJSON)}]}
        """
        let menu = try client.makeDecoder().decode(LoginMenu.self, from: Data(json.utf8))

        XCTAssertTrue(menu.primary.client.client === client)
        XCTAssertEqual(menu.options.map(\.label), ["A", "B"])
        XCTAssertTrue(menu.options[1].client.client === client)
        XCTAssertNil(menu.fallback)
        assertReadOnly(menu, tag: "oidc/client")
    }

    func testChannelMessagesDecodeWithTheOuterUserInfo() throws {
        // A message type holding an OIDC client hydrates it with the client of the decoder that decoded the channel.
        let client = BlocksClient(url: "http://localhost:3001/cdk-blocks/api")
        let channel = try client.makeDecoder().decode(RealtimeChannel<SignInOption>.self, from: Data(Self.channelJSON.utf8))
        let option = try channel.deserializer(Data(#"{"label":"L","client":\#(Self.oidcJSON)}"#.utf8))
        XCTAssertTrue(option.client.client === client)
    }
}

/// Asserts that encoding `value` throws the read-only `EncodingError` for a `tag` transferable.
private func assertReadOnly(
    _ value: some Encodable,
    tag: String,
    file: StaticString = #filePath,
    line: UInt = #line
) {
    XCTAssertThrowsError(try JSONEncoder().encode(value), file: file, line: line) { error in
        guard case EncodingError.invalidValue(_, let context) = error else {
            return XCTFail("Expected EncodingError.invalidValue, got \(error)", file: file, line: line)
        }
        XCTAssertTrue(context.debugDescription.contains("read-only"), context.debugDescription, file: file, line: line)
        XCTAssertTrue(context.debugDescription.contains(tag), context.debugDescription, file: file, line: line)
    }
}
