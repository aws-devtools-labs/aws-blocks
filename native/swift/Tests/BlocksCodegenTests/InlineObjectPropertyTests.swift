//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// A component schema's inline-object property generates a struct nested inside the
/// schema's struct (`Shipment.Destination.Geo`), so names are unique by path: two schemas
/// that each have a same-named inline property get separate types.
final class InlineObjectPropertyTests: XCTestCase {

    private func models(schemas: String, methods: String? = nil) throws -> String {
        let defaultMethods = """
        [{ "name": "api.get", "params": [],
           "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Holder" } } }]
        """
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": \(methods ?? defaultMethods),
            "components": { "schemas": \(schemas) }
        }
        """
        let rpcModel = try OpenRPCParser().parse(data: Data(json.utf8))
        return SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel)).models
    }

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func assertNoTopLevel(_ models: String, _ typeName: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(models.contains("\npublic struct \(typeName):"), "\(typeName) must not be top-level", file: file, line: line)
        XCTAssertFalse(models.contains("\npublic enum \(typeName):"), "\(typeName) must not be top-level", file: file, line: line)
    }

    // MARK: - The L48 collision

    func testSameNamedInlinePropertiesOfTwoSchemasGetSeparateTypes() throws {
        let output = try models(schemas: """
        {
            "Invoice": { "type": "object", "properties": {
                "id": { "type": "string" },
                "meta": { "type": "object", "properties": { "value": { "type": "integer" } }, "required": ["value"] }
            }, "required": ["id", "meta"] },
            "Receipt": { "type": "object", "properties": {
                "id": { "type": "string" },
                "meta": { "type": "object", "properties": { "value": { "type": "string" } }, "required": ["value"] }
            }, "required": ["id", "meta"] }
        }
        """, methods: """
        [{ "name": "api.getInvoice", "params": [],
           "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Invoice" } } },
         { "name": "api.getReceipt", "params": [],
           "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Receipt" } } }]
        """)

        assertContains(output, """
        public struct Invoice: Codable {
            public let id: String
            public let meta: Meta

            public init(id: String, meta: Meta) {
                self.id = id
                self.meta = meta
            }

            public struct Meta: Codable {
                public let value: Int

                public init(value: Int) {
                    self.value = value
                }
            }
        }
        """)
        assertContains(output, """
        public struct Receipt: Codable {
            public let id: String
            public let meta: Meta

            public init(id: String, meta: Meta) {
                self.id = id
                self.meta = meta
            }

            public struct Meta: Codable {
                public let value: String

                public init(value: String) {
                    self.value = value
                }
            }
        }
        """)
        assertNoTopLevel(output, "Meta")
    }

    // MARK: - Shapes

    func testInlineObjectPropertyNestsInsideItsSchema() throws {
        let output = try models(schemas: """
        { "Holder": { "type": "object", "properties": {
            "payload": { "type": "object", "properties": { "label": { "type": "string" } }, "required": ["label"] }
        }, "required": ["payload"] } }
        """)

        assertContains(output, """
        public struct Holder: Codable {
            public let payload: Payload

            public init(payload: Payload) {
                self.payload = payload
            }

            public struct Payload: Codable {
                public let label: String

                public init(label: String) {
                    self.label = label
                }
            }
        }
        """)
        assertNoTopLevel(output, "Payload")
    }

    func testObjectsNestedThreeLevelsDeep() throws {
        let output = try models(schemas: """
        { "Holder": { "type": "object", "properties": {
            "outer": { "type": "object", "properties": {
                "middle": { "type": "object", "properties": {
                    "inner": { "type": "object", "properties": { "n": { "type": "number" } }, "required": ["n"] }
                }, "required": ["inner"] }
            }, "required": ["middle"] }
        }, "required": ["outer"] } }
        """)

        assertContains(output, """
        public struct Holder: Codable {
            public let outer: Outer

            public init(outer: Outer) {
                self.outer = outer
            }

            public struct Outer: Codable {
                public let middle: Middle

                public init(middle: Middle) {
                    self.middle = middle
                }

                public struct Middle: Codable {
                    public let inner: Inner

                    public init(inner: Inner) {
                        self.inner = inner
                    }

                    public struct Inner: Codable {
                        public let n: Double

                        public init(n: Double) {
                            self.n = n
                        }
                    }
                }
            }
        }
        """)
        for name in ["Outer", "Middle", "Inner"] {
            assertNoTopLevel(output, name)
        }
    }

    func testOptionalAndNullableInlineObjects() throws {
        let output = try models(schemas: """
        { "Holder": { "type": "object", "properties": {
            "maybe": { "type": "object", "properties": { "a": { "type": "string" } }, "required": ["a"] },
            "orNull": { "oneOf": [
                { "type": "object", "properties": { "b": { "type": "string" } }, "required": ["b"] },
                { "type": "null" }
            ] }
        }, "required": ["orNull"] } }
        """)

        assertContains(output, "    public let maybe: Maybe?\n    public let orNull: OrNull?\n")
        assertContains(output, "\n" + """
            public struct Maybe: Codable {
                public let a: String

                public init(a: String) {
                    self.a = a
                }
            }

        """)
        assertContains(output, "\n" + """
            public struct OrNull: Codable {
                public let b: String

                public init(b: String) {
                    self.b = b
                }
            }

        """)
        assertNoTopLevel(output, "Maybe")
        assertNoTopLevel(output, "OrNull")
    }

    func testArrayAndMapOfInlineObjects() throws {
        let output = try models(schemas: """
        { "Holder": { "type": "object", "properties": {
            "parcels": { "type": "array", "items": {
                "type": "object", "properties": { "sku": { "type": "string" } }, "required": ["sku"] } },
            "customs": { "type": "object", "additionalProperties": {
                "type": "object", "properties": { "code": { "type": "string" } }, "required": ["code"] } }
        }, "required": ["parcels", "customs"] } }
        """)

        assertContains(output, "    public let customs: [String: CustomsValue]\n    public let parcels: [Parcel]\n")
        assertContains(output, "\n" + """
            public struct CustomsValue: Codable {
                public let code: String

                public init(code: String) {
                    self.code = code
                }
            }

        """)
        assertContains(output, "\n" + """
            public struct Parcel: Codable {
                public let sku: String

                public init(sku: String) {
                    self.sku = sku
                }
            }

        """)
        assertNoTopLevel(output, "CustomsValue")
        assertNoTopLevel(output, "Parcel")
    }

    func testEnumInsideInlineObjectNestsButSchemaLevelEnumStaysTopLevel() throws {
        let output = try models(schemas: """
        { "Holder": { "type": "object", "properties": {
            "status": { "type": "string", "enum": ["open", "closed"] },
            "geo": { "type": "object", "properties": {
                "source": { "type": "string", "enum": ["gps", "cell"] }
            }, "required": ["source"] }
        }, "required": ["status", "geo"] } }
        """)

        assertContains(output, "\npublic enum Status: String, Codable {\n    case open\n    case closed\n}\n")
        assertContains(output, """
            public struct Geo: Codable {
                public let source: Source

                public init(source: Source) {
                    self.source = source
                }

                public enum Source: String, Codable {
                    case gps
                    case cell
                }
            }
        """)
        assertNoTopLevel(output, "Source")
    }

    func testSameNamedNestedEnumsInTwoSchemasStaySeparate() throws {
        let output = try models(schemas: """
        {
            "Holder": { "type": "object", "properties": {
                "meta": { "type": "object", "properties": {
                    "kind": { "type": "string", "enum": ["a", "b"] } }, "required": ["kind"] }
            }, "required": ["meta"] },
            "Other": { "type": "object", "properties": {
                "meta": { "type": "object", "properties": {
                    "kind": { "type": "string", "enum": ["x", "y"] } }, "required": ["kind"] }
            }, "required": ["meta"] }
        }
        """)

        assertContains(output, "public enum Kind: String, Codable {\n            case a\n            case b\n")
        assertContains(output, "public enum Kind: String, Codable {\n            case x\n            case y\n")
        assertNoTopLevel(output, "Kind")
    }

    func testInlineUnionInsideInlineObjectNests() throws {
        let output = try models(schemas: """
        { "Holder": { "type": "object", "properties": {
            "meta": { "type": "object", "properties": {
                "figure": { "oneOf": [
                    { "type": "object", "properties": {
                        "kind": { "type": "string", "enum": ["circle"] }, "radius": { "type": "number" } },
                      "required": ["kind", "radius"] },
                    { "type": "object", "properties": {
                        "kind": { "type": "string", "enum": ["square"] }, "side": { "type": "number" } },
                      "required": ["kind", "side"] }
                ] }
            }, "required": ["figure"] }
        }, "required": ["meta"] } }
        """)

        assertContains(output, "\n    public struct Meta: Codable {\n        public let figure: Figure\n")
        assertContains(output, "\n        public enum Figure: Codable {\n            case circle(Circle)\n            case square(Square)\n")
        assertContains(output, "\n" + """
                public struct Circle: Codable {
                    public let radius: Double

                    public init(radius: Double) {
                        self.radius = radius
                    }
                }

        """)
        for name in ["Meta", "Figure", "Circle", "Square"] {
            assertNoTopLevel(output, name)
        }
    }

    func testInlineObjectInsideSchemaLevelUnionVariantNestsInThatVariant() throws {
        let output = try models(schemas: """
        { "Event": { "oneOf": [
            { "type": "object", "properties": {
                "type": { "type": "string", "enum": ["click"] },
                "meta": { "type": "object", "properties": { "x": { "type": "integer" } }, "required": ["x"] } },
              "required": ["type", "meta"] },
            { "type": "object", "properties": {
                "type": { "type": "string", "enum": ["key"] },
                "meta": { "type": "object", "properties": { "code": { "type": "string" } }, "required": ["code"] } },
              "required": ["type", "meta"] }
        ] } }
        """, methods: """
        [{ "name": "api.get", "params": [],
           "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Event" } } }]
        """)

        assertContains(output, """
        public struct Click: Codable {
            public let meta: Meta

            public init(meta: Meta) {
                self.meta = meta
            }

            public struct Meta: Codable {
                public let x: Int

                public init(x: Int) {
                    self.x = x
                }
            }
        }
        """)
        assertContains(output, """
        public struct Key: Codable {
            public let meta: Meta

            public init(meta: Meta) {
                self.meta = meta
            }

            public struct Meta: Codable {
                public let code: String

                public init(code: String) {
                    self.code = code
                }
            }
        }
        """)
        assertNoTopLevel(output, "Meta")
    }

    // MARK: - Naming

    func testNestedTypeNamedLikeAComponentSchemaIsPrefixedSoItDoesNotShadowIt() throws {
        // Inside `Order`, a nested `Address` would shadow the top-level `Address` that `billing` refers to.
        let output = try models(schemas: """
        {
            "Address": { "type": "object", "properties": { "street": { "type": "string" } }, "required": ["street"] },
            "Order": { "type": "object", "properties": {
                "address": { "type": "object", "properties": { "zip": { "type": "string" } }, "required": ["zip"] },
                "billing": { "$ref": "#/components/schemas/Address" }
            }, "required": ["address", "billing"] }
        }
        """, methods: """
        [{ "name": "api.get", "params": [],
           "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Order" } } }]
        """)

        assertContains(output, """
        public struct Order: Codable {
            public let address: OrderAddress
            public let billing: Address

            public init(address: OrderAddress, billing: Address) {
                self.address = address
                self.billing = billing
            }

            public struct OrderAddress: Codable {
                public let zip: String

                public init(zip: String) {
                    self.zip = zip
                }
            }
        }
        """)
        assertContains(output, "\n" + """
        public struct Address: Codable {
            public let street: String

            public init(street: String) {
                self.street = street
            }
        }
        """)
    }

    func testNestedTypeNamedLikeASwiftTypeIsPrefixed() throws {
        // `Holder.Type` is the metatype and can't be declared; a nested `Date` would shadow Foundation's `Date`.
        let output = try models(schemas: """
        { "Holder": { "type": "object", "properties": {
            "type": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] },
            "date": { "type": "object", "properties": { "day": { "type": "integer" } }, "required": ["day"] },
            "createdAt": { "type": "string", "format": "date-time" }
        }, "required": ["type", "date", "createdAt"] } }
        """)

        assertContains(output, "    public let createdAt: Date\n    public let date: HolderDate\n    public let `type`: HolderType\n")
        assertContains(output, "\n    public struct HolderDate: Codable {\n")
        assertContains(output, "\n    public struct HolderType: Codable {\n")
    }

    // MARK: - Unaffected

    func testSchemaReferencedTwiceDeclaresItsNestedTypesOnce() throws {
        let output = try models(schemas: """
        { "Holder": { "type": "object", "properties": {
            "payload": { "type": "object", "properties": { "label": { "type": "string" } }, "required": ["label"] }
        }, "required": ["payload"] } }
        """, methods: """
        [{ "name": "api.get", "params": [{ "name": "h", "required": true, "schema": { "$ref": "#/components/schemas/Holder" } }],
           "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Holder" } } }]
        """)

        XCTAssertEqual(output.components(separatedBy: "struct Payload:").count - 1, 1)
    }

    func testMethodLevelInlineObjectsStillNestUnderTheOperation() throws {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{ "name": "api.save", "params": [{ "name": "input", "required": true, "schema": {
                "type": "object", "properties": {
                    "meta": { "type": "object", "properties": { "x": { "type": "integer" } }, "required": ["x"] } },
                "required": ["meta"] } }],
                "result": { "name": "R", "schema": { "type": "boolean" } } }]
        }
        """
        let rpcModel = try OpenRPCParser().parse(data: Data(json.utf8))
        let output = SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))

        XCTAssertTrue(output.api.contains("public func save(input: Save.Input) async throws -> Bool"))
        XCTAssertTrue(output.api.contains("            public struct Meta: Codable {\n                public let x: Int\n"))
        XCTAssertEqual(output.models, "")
    }
}
