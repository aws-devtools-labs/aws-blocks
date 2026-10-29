//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest

// Compiles generated code as its own module, the way an app that keeps its generated client in a separate
// Swift package builds it, then type-checks a consumer module against it (or builds and runs one). Shared by
// `PublicInitTests`, `TransferableTypeArgumentTests` and `NestedTypeNameCollisionTests`. macOS only: it runs
// the host toolchain (`xcrun swiftc`).
#if os(macOS)
extension XCTestCase {
    /// The directory holding `BlocksRuntime.swiftmodule` in this test run's build products, if it's there.
    private func blocksRuntimeModuleDir() -> URL? {
        let products = Bundle(for: type(of: self)).bundleURL.deletingLastPathComponent()
        return [products.appendingPathComponent("Modules"), products].first { dir in
            FileManager.default.fileExists(atPath: dir.appendingPathComponent("BlocksRuntime.swiftmodule").path)
        }
    }

    @discardableResult
    private func swiftc(_ arguments: [String]) throws -> (status: Int32, output: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        process.arguments = ["swiftc"] + arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(bytes: data, encoding: .utf8) ?? "")
    }

    /// Builds `Models.swift` + `API.swift` as module `Generated` against this run's BlocksRuntime, then
    /// type-checks `consumer` as a separate module importing it.
    func typecheckConsumer(models: String, api: String, consumer: String) throws {
        guard FileManager.default.isExecutableFile(atPath: "/usr/bin/xcrun") else {
            throw XCTSkip("xcrun is not available")
        }
        guard let runtimeDir = blocksRuntimeModuleDir() else {
            throw XCTSkip("BlocksRuntime.swiftmodule isn't in the build products; run under `swift test`")
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("\(type(of: self))-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let modelsFile = dir.appendingPathComponent("Models.swift")
        let apiFile = dir.appendingPathComponent("API.swift")
        let consumerFile = dir.appendingPathComponent("Consumer.swift")
        try models.write(to: modelsFile, atomically: true, encoding: .utf8)
        try api.write(to: apiFile, atomically: true, encoding: .utf8)
        try consumer.write(to: consumerFile, atomically: true, encoding: .utf8)

        let module = try swiftc([
            "-emit-module", "-module-name", "Generated", "-parse-as-library",
            "-I", runtimeDir.path, "-emit-module-path", dir.appendingPathComponent("Generated.swiftmodule").path,
            modelsFile.path, apiFile.path
        ])
        XCTAssertEqual(module.status, 0, "The generated module didn't compile:\n\(module.output)")
        guard module.status == 0 else { return }

        let check = try swiftc(["-typecheck", "-module-name", "Consumer", "-I", dir.path, "-I", runtimeDir.path, consumerFile.path])
        XCTAssertEqual(check.status, 0, "The consumer module didn't compile:\n\(check.output)")
    }

    /// Builds BlocksRuntime from `Sources/BlocksRuntime`, then `Models.swift` + `API.swift` as library module
    /// `Generated` against it, then `main` as an executable that imports both, and runs it. Returns what the
    /// generated module's compile printed (its warnings) and the executable's output; nil if a step failed,
    /// which it reports as a test failure. Takes a while: it compiles the runtime. With `testableRuntime`, the
    /// runtime is built with `-enable-testing`, so `main` can `@testable import BlocksRuntime`.
    func runConsumer(
        models: String, api: String, main: String, testableRuntime: Bool = false
    ) throws -> (compilerOutput: String, output: String)? {
        guard FileManager.default.isExecutableFile(atPath: "/usr/bin/xcrun") else {
            throw XCTSkip("xcrun is not available")
        }
        let runtimeSources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/BlocksRuntime")
        guard let enumerator = FileManager.default.enumerator(at: runtimeSources, includingPropertiesForKeys: nil) else {
            throw XCTSkip("Sources/BlocksRuntime isn't next to the tests")
        }
        let runtimeFiles = enumerator.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }.map(\.path).sorted()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("\(type(of: self))-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let modelsFile = dir.appendingPathComponent("Models.swift")
        let apiFile = dir.appendingPathComponent("API.swift")
        let mainFile = dir.appendingPathComponent("main.swift")
        try models.write(to: modelsFile, atomically: true, encoding: .utf8)
        try api.write(to: apiFile, atomically: true, encoding: .utf8)
        try main.write(to: mainFile, atomically: true, encoding: .utf8)

        // Package.swift: `platforms: [.iOS(.v16), .macOS(.v13)]`.
        #if arch(arm64)
        let common: [String] = ["-swift-version", "5", "-target", "arm64-apple-macos13.0"]
        #else
        let common: [String] = ["-swift-version", "5", "-target", "x86_64-apple-macos13.0"]
        #endif
        let search: [String] = ["-I", dir.path, "-L", dir.path]
        // Every `swiftc` argument list below is assembled one explicitly typed `[String]` step at a time. As a
        // single chained `+` expression over array literals, `map` and string interpolation it type-checks on
        // Swift 6.3 but defeats the constraint solver on the older toolchains CI runs ("the compiler is unable
        // to type-check this expression in reasonable time"). Keep each step to one `+=` of a typed value.
        func library(_ module: String, _ files: [String], linking libraries: [String] = [], flags: [String] = []) throws -> String? {
            let modulePath: String = dir.appendingPathComponent("\(module).swiftmodule").path
            let libraryPath: String = dir.appendingPathComponent("lib\(module).dylib").path
            let emit: [String] = [
                "-parse-as-library", "-module-name", module, "-emit-library", "-emit-module",
                "-emit-module-path", modulePath,
                "-o", libraryPath
            ]
            let links: [String] = libraries.map { "-l\($0)" }
            var arguments: [String] = common
            arguments += flags
            arguments += emit
            arguments += search
            arguments += links
            arguments += files
            let step = try swiftc(arguments)
            XCTAssertEqual(step.status, 0, "\(module) didn't compile:\n\(step.output)")
            return step.status == 0 ? step.output : nil
        }
        let runtimeFlags: [String] = testableRuntime ? ["-enable-testing"] : []
        let generatedFiles: [String] = [modelsFile.path, apiFile.path]
        guard try library("BlocksRuntime", runtimeFiles, flags: runtimeFlags) != nil,
              let generated = try library("Generated", generatedFiles, linking: ["BlocksRuntime"])
        else { return nil }
        let executable = dir.appendingPathComponent("consumer")
        let consumerOutput: [String] = ["-module-name", "Consumer", "-o", executable.path]
        let consumerLink: [String] = ["-lGenerated", "-lBlocksRuntime", "-Xlinker", "-rpath", "-Xlinker", dir.path]
        var buildArguments: [String] = common
        buildArguments += consumerOutput
        buildArguments += search
        buildArguments += consumerLink
        buildArguments.append(mainFile.path)
        let build = try swiftc(buildArguments)
        XCTAssertEqual(build.status, 0, "The consumer didn't compile:\n\(build.output)")
        guard build.status == 0 else { return nil }

        let process = Process()
        process.executableURL = executable
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let output = String(bytes: data, encoding: .utf8) ?? ""
        XCTAssertEqual(process.terminationStatus, 0, "The consumer failed:\n\(output)")
        return process.terminationStatus == 0 ? (generated, output) : nil
    }

    /// Swift source for a `runConsumer` `main`: `startJSONRPCServer { method, params, body in resultJSON }` serves
    /// JSON-RPC on a free local port, one request per connection, answering each call with the JSON `respond`
    /// returns for its method, positional params (as `JSONSerialization` reads them) and raw request body. Returns
    /// the port. Needs `import Foundation`.
    static let jsonRPCServerSource = ##"""
    func startJSONRPCServer(_ respond: @escaping (String, [Any], String) -> String) -> UInt16 {
        let listener = socket(AF_INET, SOCK_STREAM, 0)
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, length) } }
        _ = listen(listener, 4)
        _ = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &length) }
        }
        Thread.detachNewThread {
            while true {
                let connection = accept(listener, nil, nil)
                guard connection >= 0 else { return }
                var request = Data()
                var buffer = [UInt8](repeating: 0, count: 4096)
                var body = ""
                while true {
                    let count = read(connection, &buffer, buffer.count)
                    guard count > 0 else { break }
                    request.append(contentsOf: buffer[0 ..< count])
                    let text = String(decoding: request, as: UTF8.self)
                    guard let end = text.range(of: "\r\n\r\n") else { continue }
                    let header = text[..<end.lowerBound].lowercased()
                    let declared = header.components(separatedBy: "\r\n")
                        .first { $0.hasPrefix("content-length:") }
                        .flatMap { Int($0.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)) } ?? 0
                    body = String(text[end.upperBound...])
                    if body.utf8.count >= declared { break }
                }
                let call = (try? JSONSerialization.jsonObject(with: Data(body.utf8))) as? [String: Any] ?? [:]
                let result = respond(call["method"] as? String ?? "", call["params"] as? [Any] ?? [], body)
                let reply = #"{"jsonrpc":"2.0","id":1,"result":\#(result)}"#
                let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(reply.utf8.count)\r\n"
                    + "Connection: close\r\n\r\n\(reply)"
                _ = response.withCString { write(connection, $0, strlen($0)) }
                close(connection)
            }
        }
        return UInt16(bigEndian: address.sin_port)
    }
    """##
}
#endif
