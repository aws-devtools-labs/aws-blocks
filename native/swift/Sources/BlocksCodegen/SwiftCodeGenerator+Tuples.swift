//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Tuples

extension SwiftCodeGenerator {
    /// Whether a record with `fields` is a tuple (`prefixItems`): a JSON array of its fields' values on the wire.
    func isTupleRecord(_ fields: [ResolvedField]) -> Bool {
        !fields.isEmpty && fields.allSatisfy(\.positional)
    }

    /// The `Codable` members of a tuple record, after its stored properties: it reads and writes a JSON array of its
    /// elements (`item0`, `item1`, …), in order, not an object keyed by their names (synthesized `Codable` would).
    /// An element missing from a shorter array (an optional element, TypeScript `[string, number?]`) is `nil`.
    /// Lines are indented for the struct's body; the caller adds the struct's own indentation.
    func tupleCodableLines(fields: [ResolvedField]) -> [String] {
        var body = [""]
        body.append("    public init(from decoder: Decoder) throws {")
        body.append("        var c = try decoder.unkeyedContainer()")
        for field in fields {
            let safe = propertyName(field, in: fields)
            let swType = swiftTypeNameNoEmit(field.type)
            if swType.hasSuffix("?") {
                body.append("        self.\(safe) = try c.decodeIfPresent(\(swType.dropLast()).self)")
            } else {
                body.append("        self.\(safe) = try c.decode(\(swType).self)")
            }
        }
        body.append("    }")
        body.append("")
        body.append("    public func encode(to encoder: Encoder) throws {")
        body.append("        var c = encoder.unkeyedContainer()")
        for field in fields {
            body.append("        try c.encode(self.\(propertyName(field, in: fields)))")
        }
        body.append("    }")
        return body
    }
}
