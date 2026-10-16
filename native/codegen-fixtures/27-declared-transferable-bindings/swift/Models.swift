import Foundation
import BlocksRuntime


public struct DeviceLabel: Codable {
    public let name: String

    public init(name: String) throws {
        guard name.count >= 1 else { throw BlocksRuntime.CodegenError.validation("name must be at least 1 characters") }
        self.name = name
    }
}