//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// A tuple (`prefixItems`, TypeScript `[number, number]`) is a struct with one property per element (`item0`,
/// `item1`, …), but on the wire it is a JSON array of their values. Synthesized `Codable` read and wrote an object
/// keyed `item0`, `item1`, so a generated client could neither decode a tuple the server sent nor send one it
/// could read. Generated from fixture `11-tuples`, which holds tuples as results, parameters, an object's
/// property and a list's elements.
final class TupleWireFormatTests: XCTestCase {

    private func fixtureSources() throws -> GeneratedSources {
        let spec = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("../codegen-fixtures/11-tuples/spec.json")
        let rpcModel = try OpenRPCParser().parse(data: try Data(contentsOf: spec))
        return try SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    func testTupleCodesAsAJSONArray() throws {
        let output = try fixtureSources()
        XCTAssertTrue(output.api.contains("var c = try decoder.unkeyedContainer()"))
        XCTAssertTrue(output.api.contains("var c = encoder.unkeyedContainer()"))
    }

    func testTupleRoundTripsItsWireJSON() throws {
        #if os(macOS)
        let output = try fixtureSources()
        let main = """
        import Foundation
        import BlocksRuntime
        import Generated

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        func roundTrip<T: Codable>(_ json: String, as type: T.Type) throws -> String {
            let decoded = try JSONDecoder().decode(T.self, from: Data(json.utf8))
            return String(decoding: try encoder.encode(decoded), as: UTF8.self)
        }

        print(try roundTrip(#"[1.5,2,"z"]"#, as: Api.GetCoords.Result.self))
        print(try roundTrip(#"["a",3]"#, as: Api.GetPair.Result.self))
        print(try roundTrip(#"[0,10]"#, as: Api.QueryRange.Range.self))
        print(try roundTrip(#"["c",4]"#, as: Api.QueryRange.Cursor.self))
        print(try roundTrip(#"["c"]"#, as: Api.QueryRange.Cursor.self))
        print(try roundTrip(#"{"pairs":[["p",1],["q",2]],"where":{"between":["a","m"]}}"#, as: Api.QueryRange.Result.self))
        print(try roundTrip(#"{"one":[5],"short":["c"]}"#, as: Api.GetShortTuples.Result.self))
        let range = Api.QueryRange.Range(item0: 0, item1: 10)
        print(String(decoding: try encoder.encode(range), as: UTF8.self))
        do {
            _ = try JSONDecoder().decode(Api.QueryRange.Range.self, from: Data(#"{"item0":0,"item1":10}"#.utf8))
            print("decoded an object")
        } catch {
            print("rejected an object")
        }
        """
        guard let run = try runConsumer(models: output.models, api: output.api, main: main) else { return }
        XCTAssertFalse(run.compilerOutput.contains("warning:"), "The generated module compiled with warnings:\n\(run.compilerOutput)")
        XCTAssertEqual(run.output.split(separator: "\n").map(String.init), [
            #"[1.5,2,"z"]"#,
            #"["a",3]"#,
            #"[0,10]"#,
            #"["c",4]"#,
            #"["c",null]"#,
            #"{"pairs":[["p",1],["q",2]],"where":{"between":["a","m"]}}"#,
            #"{"one":[5],"short":["c",null]}"#,
            #"[0,10]"#,
            "rejected an object"
        ])
        #else
        throw XCTSkip("Compiling and running the generated module needs the host toolchain (macOS only).")
        #endif
    }
}
