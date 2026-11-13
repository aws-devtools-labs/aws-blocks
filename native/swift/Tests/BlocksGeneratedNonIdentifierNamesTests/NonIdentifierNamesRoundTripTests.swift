//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import BlocksRuntime
import Foundation
import XCTest

/// Generated types for keys that are not identifiers keep each key's wire spelling.
final class NonIdentifierNamesRoundTripTests: XCTestCase {

    func testRecordKeysRoundTrip() throws {
        let json = #"""
        {
          "run { error(\"x\") } || id": "id",
          "$": "dollar",
          "${x}": "interp",
          "\\(y)": "paren",
          "*/": "comment",
          "q\"uote": "quote",
          "s'ingle": "single",
          "semi;colon": "semi",
          "back`tick": "tick",
          "new\nline": "newline",
          "with space": 3,
          "9lives": true,
          "kind": "x`y"
        }
        """#
        let decoded = try JSONDecoder().decode(Sample_Type__X___.self, from: Data(json.utf8))

        XCTAssertEqual(decoded.run___error__x________id, "id")
        XCTAssertEqual(decoded._unnamed, "dollar")
        XCTAssertEqual(decoded.__x_, "interp")
        XCTAssertEqual(decoded.__y_, "paren")
        XCTAssertEqual(decoded.__unnamed, "comment")
        XCTAssertEqual(decoded.q_uote, "quote")
        XCTAssertEqual(decoded.s_ingle, "single")
        XCTAssertEqual(decoded.semi_colon, "semi")
        XCTAssertEqual(decoded.back_tick, "tick")
        XCTAssertEqual(decoded.new_line, "newline")
        XCTAssertEqual(decoded.with_space, 3)
        XCTAssertEqual(decoded._9lives, true)
        XCTAssertEqual(decoded.kind, .x_y)

        let reencoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as? NSDictionary)
        let original = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? NSDictionary)
        XCTAssertEqual(reencoded, original)
    }

    func testEnumValuesRoundTrip() throws {
        let values = ["a\"b", "c;d", "x`y", "new\nline", "${x}", "\\(z)", "*/", "1st", " sp ace"]
        for value in values {
            let encodedValue = try JSONEncoder().encode([value])
            let decoded = try JSONDecoder().decode([Kind].self, from: encodedValue)
            XCTAssertEqual(decoded.first?.rawValue, value)
            XCTAssertEqual(try JSONDecoder().decode([String].self, from: JSONEncoder().encode(decoded)), [value])
        }
    }

    func testDiscriminatedUnionKeepsTagAndKeys() throws {
        let json = #"{"ty pe": "re`move", "${id}": "abc"}"#
        let decoded = try JSONDecoder().decode(Ns.Do_Action.Input.self, from: Data(json.utf8))
        guard case .ty_PeRe_Move(let payload) = decoded else {
            return XCTFail("decoded \(decoded)")
        }
        XCTAssertEqual(payload.__id_, "abc")

        let reencoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as? [String: String]
        XCTAssertEqual(reencoded, ["ty pe": "re`move", "${id}": "abc"])
    }
}
