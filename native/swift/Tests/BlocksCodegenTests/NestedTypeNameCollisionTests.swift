//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// A nested type's name is derived from its property: `item: {…}` declares `Item`, and so does `items: [{…}]`
/// (the element, singularized), as do `feed: channel<{…}>` and `feeds: [channel<{…}>]` (`FeedMessage`). Two
/// siblings that derive one name used to declare the type twice, so the parent didn't compile. Names are now
/// allocated per scope: the property whose own type it is keeps the name, and a derived sibling takes the name
/// without singularizing (`Items`, `FeedsMessage`), else a numeric suffix (`TagsValue_2`). Inline types
/// registered at the top level of Models.swift no longer silently share a name with a different type.
final class NestedTypeNameCollisionTests: XCTestCase {

    private func generate(schemas: String = "{}", methods: [String]) throws -> GeneratedSources {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [\(methods.joined(separator: ", "))],
            "components": { "schemas": \(schemas) }
        }
        """
        let rpcModel = try OpenRPCParser().parse(data: Data(json.utf8))
        return SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    private func method(_ name: String, params: String = "[]", result: String) -> String {
        """
        { "name": "api.\(name)", "params": \(params), "result": { "name": "R", "schema": \(result) } }
        """
    }

    private func returning(_ schema: String) -> String {
        method("get\(schema)", result: ##"{ "$ref": "#/components/schemas/\##(schema)" }"##)
    }

    private func object(_ properties: [String: String]) -> String {
        let props = properties.sorted { $0.key < $1.key }.map { "\"\($0.key)\": \($0.value)" }.joined(separator: ", ")
        let required = properties.keys.sorted().map { "\"\($0)\"" }.joined(separator: ", ")
        return #"{ "type": "object", "properties": { \#(props) }, "required": [\#(required)] }"#
    }

    private func array(_ items: String) -> String { #"{ "type": "array", "items": \#(items) }"# }
    private func map(_ values: String) -> String { #"{ "type": "object", "additionalProperties": \#(values) }"# }
    private func channel(_ message: String) -> String {
        #"{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [\#(message)] }"#
    }
    private func strings(_ values: String...) -> String {
        #"{ "type": "string", "enum": [\#(values.map { "\"\($0)\"" }.joined(separator: ", "))] }"#
    }
    private func param(_ name: String, _ schema: String) -> String {
        #"{ "name": "\#(name)", "required": true, "schema": \#(schema) }"#
    }

    private let string = #"{ "type": "string" }"#
    private let number = #"{ "type": "number" }"#

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func assertNotContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(haystack.contains(needle), "Expected generated code not to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func count(_ needle: String, in haystack: String) -> Int {
        haystack.components(separatedBy: needle).count - 1
    }

    // MARK: - A component schema's struct

    func testPropertyAndArrayOfItsPluralInASchemaDeclareTwoTypes() throws {
        let cart = object(["item": object(["sku": string]), "items": array(object(["sku": string, "qty": number]))])
        let output = try generate(schemas: #"{ "Cart": \#(cart) }"#, methods: [returning("Cart")])

        assertContains(output.models, "public let item: Item\n")
        assertContains(output.models, "public let items: [Items]\n")
        XCTAssertEqual(count("public struct Item: Codable {", in: output.models), 1)
        assertContains(output.models, "public struct Items: Codable {\n        public let qty: Double\n        public let sku: String")
    }

    func testEnumsInANestedRecordCollide() throws {
        let cart = object(["detail": object(["kind": strings("a", "b"), "kinds": array(strings("c", "d"))])])
        let output = try generate(schemas: #"{ "Cart": \#(cart) }"#, methods: [returning("Cart")])

        assertContains(output.models, "public let kind: Kind\n")
        assertContains(output.models, "public let kinds: [Kinds]\n")
        assertContains(output.models, "public enum Kind: String, Codable {\n            case a\n            case b")
        assertContains(output.models, "public enum Kinds: String, Codable {\n            case c\n            case d")
    }

    func testDirectPropertyKeepsItsNameOverAMapsValueType() throws {
        let bag = object(["tags": map(object(["label": string])), "tagsValue": object(["weight": number])])
        let output = try generate(schemas: #"{ "Bag": \#(bag) }"#, methods: [returning("Bag")])

        assertContains(output.models, "public let tags: [String: TagsValue_2]\n")
        assertContains(output.models, "public let tagsValue: TagsValue\n")
        assertContains(output.models, "public struct TagsValue_2: Codable {\n        public let label: String")
        assertContains(output.models, "public struct TagsValue: Codable {\n        public let weight: Double")
    }

    func testPropertiesThatDifferOnlyInCase() throws {
        let box = object(["UserName": object(["b": number]), "userName": object(["a": string])])
        let output = try generate(schemas: #"{ "Box": \#(box) }"#, methods: [returning("Box")])

        // Fields are sorted, so `UserName` comes first and keeps the name.
        assertContains(output.models, "public let UserName: UserName\n")
        assertContains(output.models, "public let userName: UserName_2\n")
        assertContains(output.models, "public struct UserName_2: Codable {\n        public let a: String")
    }

    // MARK: - The top level of Models.swift

    func testEnumAndListOfEnumsOnASchemaStayTopLevelUnderTwoNames() throws {
        let ticket = object(["kind": strings("bug", "task"), "kinds": array(strings("urgent", "later"))])
        let output = try generate(schemas: #"{ "Ticket": \#(ticket) }"#, methods: [returning("Ticket")])

        assertContains(output.models, "public enum Kind: String, Codable {\n    case bug\n    case task\n}")
        assertContains(output.models, "public enum Kinds: String, Codable {\n    case urgent\n    case later\n}")
        assertContains(output.models, "public let kinds: [Kinds]\n")
    }

    func testUnionAndListOfUnionsOnASchemaStayTopLevelUnderTwoNames() throws {
        let text = object(["type": strings("text"), "body": string])
        let count = object(["type": strings("count"), "total": number])
        let plain = object(["format": strings("plain"), "raw": string])
        let rich = object(["format": strings("rich"), "html": string])
        let event = object([
            "payload": #"{ "oneOf": [\#(text), \#(count)] }"#,
            "payloads": array(#"{ "oneOf": [\#(plain), \#(rich)] }"#)
        ])
        let output = try generate(schemas: #"{ "Event": \#(event) }"#, methods: [returning("Event")])

        // Before, `payloads` reused `Payload` (the text/count union), so a plain/rich element didn't decode.
        assertContains(output.models, "public enum Payload: Codable {\n    case text(Text)\n    case count(Count)")
        assertContains(output.models, "public enum Payloads: Codable {\n    case plain(Plain)\n    case rich(Rich)")
        assertContains(output.models, "public let payload: Payload\n")
        assertContains(output.models, "public let payloads: [Payloads]\n")
    }

    func testSameNamedEnumsOfTwoSchemasDontMerge() throws {
        let schemas = """
        { "Order": \(object(["status": strings("pending", "shipped")])),
          "Ticket": \(object(["status": strings("open", "closed")])) }
        """
        let output = try generate(schemas: schemas, methods: [returning("Order"), returning("Ticket")])

        // Before, `Ticket.status` was typed as `Order`'s enum, so `"open"` didn't decode.
        assertContains(output.models, "public enum Status: String, Codable {\n    case pending\n    case shipped\n}")
        assertContains(output.models, "public enum TicketStatus: String, Codable {\n    case open\n    case closed\n}")
        assertContains(output.models, "public struct Ticket: Codable {\n    public let status: TicketStatus\n")
    }

    func testIdenticalEnumsOfTwoSchemasStillShareOneType() throws {
        let schemas = """
        { "Order": \(object(["status": strings("open", "closed")])),
          "Ticket": \(object(["status": strings("open", "closed")])) }
        """
        let output = try generate(schemas: schemas, methods: [returning("Order"), returning("Ticket")])

        XCTAssertEqual(count("public enum Status: String, Codable {", in: output.models), 1)
        assertNotContains(output.models, "TicketStatus")
        assertContains(output.models, "public struct Ticket: Codable {\n    public let status: Status\n")
    }

    func testInlineTypeDoesntReplaceAComponentSchemaOfItsName() throws {
        let schemas = """
        { "Alpha": \(object(["kind": strings("a", "b"), "status": strings("on", "off")])),
          "Kind": \(strings("x", "y")),
          "Status": \(object(["code": string])),
          "Zed": \(object(["kind": ##"{ "$ref": "#/components/schemas/Kind" }"##])) }
        """
        let output = try generate(schemas: schemas, methods: ["Alpha", "Kind", "Status", "Zed"].map(returning))

        // Before, `Alpha`'s inline enums took the names and the component schemas were lost: `Status` (a struct)
        // wasn't generated at all, and `Kind` had `Alpha.kind`'s cases.
        assertContains(output.models, "public enum AlphaKind: String, Codable {\n    case a\n    case b\n}")
        assertContains(output.models, "public enum AlphaStatus: String, Codable {\n    case on\n    case off\n}")
        assertContains(output.models, "public enum Kind: String, Codable {\n    case x\n    case y\n}")
        assertContains(output.models, "public struct Status: Codable {\n    public let code: String")
        assertContains(output.models, "public struct Zed: Codable {\n    public let kind: Kind\n")
    }

    func testInlineEnumIdenticalToAComponentSchemaReusesIt() throws {
        let schemas = """
        { "Alpha": \(object(["kind": strings("x", "y")])), "Kind": \(strings("x", "y")) }
        """
        let output = try generate(schemas: schemas, methods: [returning("Alpha"), returning("Kind")])

        XCTAssertEqual(count("public enum Kind: String, Codable {", in: output.models), 1)
        assertNotContains(output.models, "AlphaKind")
    }

    // MARK: - An operation's types

    func testParameterAndArrayOfItsPluralParameter() throws {
        let params = "[\(param("item", object(["sku": string]))), \(param("items", array(object(["sku": string, "qty": number]))))]"
        let output = try generate(methods: [method("putItems", params: params, result: string)])

        assertContains(output.api, "public func putItems(item: PutItems.Item, items: [PutItems.Items]) async throws -> String {")
        XCTAssertEqual(count("public struct Item: Codable {", in: output.api), 1)
        assertContains(output.api, "public struct Items: Codable {\n            public let qty: Double")
    }

    func testResultPropertiesCollide() throws {
        let result = object(["item": object(["sku": string]), "items": array(object(["qty": number]))])
        let output = try generate(methods: [method("getItems", result: result)])

        assertContains(output.api, "public let item: Item\n")
        assertContains(output.api, "public let items: [Items]\n")
        assertContains(output.api, "public struct Items: Codable {\n                public let qty: Double")
    }

    func testChannelAndListOfChannels() throws {
        let result = object(["feed": channel(object(["text": string])), "feeds": array(channel(object(["count": number])))])
        let output = try generate(methods: [method("getFeeds", result: result)])

        assertContains(output.api, "public let feed: RealtimeChannel<FeedMessage>\n")
        assertContains(output.api, "public let feeds: [RealtimeChannel<FeedsMessage>]\n")
        assertContains(output.api, "public struct FeedMessage: Codable {\n                public let text: String")
        assertContains(output.api, "public struct FeedsMessage: Codable {\n                public let count: Double")
    }

    func testChannelParameterAndListOfChannelParameters() throws {
        let params = "[\(param("feed", channel(object(["text": string])))), \(param("feeds", array(channel(object(["count": number])))))]"
        let output = try generate(methods: [method("relay", params: params, result: string)])

        assertContains(
            output.api,
            "public func relay(feed: RealtimeChannel<Relay.FeedMessage>, feeds: [RealtimeChannel<Relay.FeedsMessage>]) async throws -> String {"
        )
    }

    func testParameterNamedResultLeavesTheResultItsName() throws {
        let params = "[\(param("result", object(["input": string])))]"
        let output = try generate(methods: [method("check", params: params, result: object(["passed": #"{ "type": "boolean" }"#]))])

        assertContains(output.api, "public func check(result: Check.Result_2) async throws -> Check.Result {")
        assertContains(output.api, "public struct Result_2: Codable {\n            public let input: String")
        assertContains(output.api, "public struct Result: Codable {\n            public let passed: Bool")
    }

    func testSignatureNamesTheOperationsOwnTypeOverADeeperOneOfTheSameName() throws {
        let params = "[\(param("item", object(["a": string])))]"
        let output = try generate(methods: [method("swap", params: params, result: object(["item": object(["b": number])]))])

        // Before, the parameter was typed `Swap.Result.Item`, the result's property type.
        assertContains(output.api, "public func swap(item: Swap.Item) async throws -> Swap.Result {")
    }

    func testUnionVariantPropertiesCollide() throws {
        let pick = object(["action": strings("pick"), "item": object(["sku": string]), "items": array(object(["qty": number]))])
        let skip = object(["action": strings("skip"), "reason": string])
        let output = try generate(methods: [method("act", result: #"{ "oneOf": [\#(pick), \#(skip)] }"#)])

        assertContains(output.api, "public struct Pick: Codable {\n            public let item: Item\n            public let items: [Items]\n")
    }

    // MARK: - Names that don't collide are unchanged

    func testNamesThatDontCollideAreUnchanged() throws {
        let shipment = object([
            "address": object(["city": string]),
            "parcels": array(object(["sku": string])),
            "customs": map(object(["code": string])),
            "status": strings("open", "closed")
        ])
        let schemas = #"{ "Address": \#(object(["line": string])), "Shipment": \#(shipment) }"#
        let feed = object(["feed": channel(object(["text": string])), "notes": array(object(["body": string]))])
        let output = try generate(
            schemas: schemas,
            methods: [returning("Shipment"), method("watch", params: "[\(param("filter", object(["q": string])))]", result: feed)]
        )

        assertContains(output.models, "public let address: ShipmentAddress\n")
        assertContains(output.models, "public let parcels: [Parcel]\n")
        assertContains(output.models, "public let customs: [String: CustomsValue]\n")
        assertContains(output.models, "public let status: Status\n")
        assertContains(output.api, "public func watch(filter: Watch.Filter) async throws -> Watch.Result {")
        assertContains(output.api, "public let feed: RealtimeChannel<FeedMessage>\n")
        assertContains(output.api, "public let notes: [Note]\n")
        assertNotContains(output.models + output.api, "_2")
    }

    // MARK: - Warnings (fixture 09)

    func testUnionWithAFieldlessFallbackDoesntKeepTheDecodingError() throws {
        // An empty object arm is the fieldless fallback. (Fixture 09's string arm was one until FX28: it now
        // carries its value, see `PrimitiveUnionArmTests`.)
        let query = #"{ "anyOf": [\#(object(["text": string])), { "type": "object", "properties": {} }] }"#
        let output = try generate(methods: [method("search", params: "[\(param("query", query))]", result: string)])

        assertNotContains(output.api, "var c = encoder.container(keyedBy: EmptyKey.self)")
        assertNotContains(output.api, "var lastError")
        assertContains(output.api, "_ = encoder.container(keyedBy: EmptyKey.self)")
        assertContains(output.api, "if let value = try? Query_Variant0(from: decoder) {\n                    self = .query_Variant0(value)\n")
    }

    func testUnionWithoutAFallbackStillThrowsTheLastError() throws {
        let either = #"{ "anyOf": [\#(object(["a": string])), \#(object(["b": number]))] }"#
        let output = try generate(methods: [method("pick", result: either)])

        assertContains(output.api, "var lastError: Error?")
        assertContains(output.api, "throw lastError ?? DecodingError.dataCorrupted(")
    }

    // MARK: - Compiles, without warnings, and round-trips

    func testCollidingShapesCompileWithoutWarningsAndRoundTrip() throws {
        #if os(macOS)
        let schemas = """
        {
          "Cart": \(object([
            "item": object(["sku": string]), "items": array(object(["sku": string, "qty": number])),
            "tags": map(object(["label": string])), "tagsValue": object(["weight": number])
          ])),
          "Kind": \(strings("x", "y")),
          "Order": \(object(["status": strings("pending", "shipped")])),
          "Ticket": \(object([
            "status": strings("open", "closed"), "kind": strings("bug", "task"), "kinds": array(strings("urgent", "later")),
            "payload": #"{ "oneOf": [\#(object(["type": strings("text"), "body": string])), \#(object(["type": strings("count"), "total": number]))] }"#,
            "payloads": array(
                #"{ "oneOf": [\#(object(["format": strings("plain"), "raw": string])), \#(object(["format": strings("rich"), "html": string]))] }"#
            )
          ]))
        }
        """
        let pick = object(["action": strings("pick"), "item": object(["sku": string]), "items": array(object(["qty": number]))])
        let skip = object(["action": strings("skip"), "reason": string])
        let output = try generate(schemas: schemas, methods: ["Cart", "Kind", "Order", "Ticket"].map(returning) + [
            method(
                "putItems",
                params: "[\(param("item", object(["sku": string]))), \(param("items", array(object(["sku": string, "qty": number]))))]",
                result: object(["item": object(["count": number]), "items": array(object(["sku": string]))])
            ),
            method("getFeeds", result: object(["feed": channel(object(["text": string])), "feeds": array(channel(object(["count": number])))])),
            method("relay", params: "[\(param("feed", channel(object(["text": string])))), \(param("feeds", array(channel(object(["count": number])))))]",
                   result: string),
            method("check", params: "[\(param("result", object(["input": string])))]", result: object(["passed": #"{ "type": "boolean" }"#])),
            method("act", result: #"{ "oneOf": [\#(pick), \#(skip)] }"#),
            method("search", params: "[\(param("query", #"{ "anyOf": [{ "type": "string" }, \#(object(["text": string]))] }"#))]", result: string)
        ])
        let main = """
        import Foundation
        import BlocksRuntime
        import Generated

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        func roundTrip<T: Codable>(_ json: String, as type: T.Type) throws -> String {
            let decoded = try JSONDecoder().decode(T.self, from: Data(json.utf8))
            let reencoded = try JSONDecoder().decode(T.self, from: try encoder.encode(decoded))
            return String(decoding: try encoder.encode(reencoded), as: UTF8.self)
        }

        // Every type is nameable from outside the module.
        func signatures(_ api: Api, feed: RealtimeChannel<Api.Relay.FeedMessage>) async throws {
            let items: Api.PutItems.Result = try await api.putItems(
                item: Api.PutItems.Item(sku: "a"), items: [Api.PutItems.Items(qty: 1, sku: "b")]
            )
            let feeds: Api.GetFeeds.Result = try await api.getFeeds()
            let first: RealtimeChannel<Api.GetFeeds.Result.FeedMessage> = feeds.feed
            let rest: [RealtimeChannel<Api.GetFeeds.Result.FeedsMessage>] = feeds.feeds
            let relayed: String = try await api.relay(feed: feed, feeds: [RealtimeChannel<Api.Relay.FeedsMessage>]())
            let checked: Api.Check.Result = try await api.check(result: Api.Check.Result_2(input: "c"))
            let picked: Api.Act.Result = try await api.act()
            _ = (items, first, rest, relayed, checked, picked)
            _ = (Api.PutItems.Result.Item(count: 1), Api.PutItems.Result.Items(sku: "d"))
            _ = (Api.Act.Pick.Item(sku: "e"), Api.Act.Pick.Items(qty: 2))
        }

        print(try roundTrip(#"{"item":{"sku":"a"},"items":[{"qty":2,"sku":"b"}],"tags":{"t":{"label":"l"}},"tagsValue":{"weight":3}}"#, as: Cart.self))
        let cart = Cart(item: Cart.Item(sku: "a"), items: [Cart.Items(qty: 2, sku: "b")],
                        tags: ["t": Cart.TagsValue_2(label: "l")], tagsValue: Cart.TagsValue(weight: 3))
        print(String(decoding: try encoder.encode(cart), as: UTF8.self))
        print(try roundTrip(#"{"status":"shipped"}"#, as: Order.self))
        let ticket = #"{"kind":"task","kinds":["urgent","later"],"payload":{"type":"count","total":4},"#
            + #""payloads":[{"format":"rich","html":"<b>"},{"format":"plain","raw":"r"}],"status":"open"}"#
        print(try roundTrip(ticket, as: Ticket.self))
        print(try roundTrip(#""y""#, as: Kind.self))
        print(try roundTrip(#"{"item":{"count":5},"items":[{"sku":"s"}]}"#, as: Api.PutItems.Result.self))
        print(try roundTrip(#"{"input":"i"}"#, as: Api.Check.Result_2.self))
        print(try roundTrip(#"{"action":"pick","item":{"sku":"p"},"items":[{"qty":6}]}"#, as: Api.Act.Result.self))
        print(try roundTrip(#"{"text":"q"}"#, as: Api.Search.Query.self))
        """
        guard let run = try runConsumer(models: output.models, api: output.api, main: main) else { return }

        XCTAssertFalse(run.compilerOutput.contains("warning:"), "The generated module compiled with warnings:\n\(run.compilerOutput)")
        let cartJSON = #"{"item":{"sku":"a"},"items":[{"qty":2,"sku":"b"}],"tags":{"t":{"label":"l"}},"tagsValue":{"weight":3}}"#
        XCTAssertEqual(run.output.split(separator: "\n").map(String.init), [
            cartJSON,
            cartJSON,
            #"{"status":"shipped"}"#,
            #"{"kind":"task","kinds":["urgent","later"],"payload":{"total":4,"type":"count"},"#
                + #""payloads":[{"format":"rich","html":"<b>"},{"format":"plain","raw":"r"}],"status":"open"}"#,
            #""y""#,
            #"{"item":{"count":5},"items":[{"sku":"s"}]}"#,
            #"{"input":"i"}"#,
            #"{"action":"pick","item":{"sku":"p"},"items":[{"qty":6}]}"#,
            #"{"text":"q"}"#
        ])
        #else
        throw XCTSkip("Compiling and running the generated module needs the host toolchain (macOS only).")
        #endif
    }
}
