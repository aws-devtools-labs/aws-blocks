import Foundation
import BlocksRuntime

public class Api {
    private let client: BlocksClient

    public init(server: BlocksServer = Servers.local) {
        self.client = BlocksClient(server: server)
    }

    /// Calls `api.setScore`.
    public func setScore(input: SetScore.Input) async throws -> SetScore.Result {
        let request = BlocksRequest(method: "api.setScore", params: [input], id: BlocksRequest.nextId())
        let result = try await client.execute(request)
        guard let result else { throw RPCError(message: "Unexpected null result for api.setScore") }
        return try JSONDecoder().decode(SetScore.Result.self, from: result)
    }

    public enum SetScore {

        public struct Input: Codable {
            public let level: Int
            public let score: Double
            public let step: Double

            public init(level: Int, score: Double, step: Double) throws {
                self.level = level
                guard score >= 0.0 else { throw CodegenError.validation("score must be >= 0.0") }
                guard score <= 100.0 else { throw CodegenError.validation("score must be <= 100.0") }
                self.score = score
                guard step.truncatingRemainder(dividingBy: 0.5) == 0 else { throw CodegenError.validation("step must be a multiple of 0.5") }
                self.step = step
            }
        }

        public struct Result: Codable {
            public let ok: Bool

            public init(ok: Bool) {
                self.ok = ok
            }
        }
    }
}


// MARK: - Servers

public enum Servers {
    public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")
}