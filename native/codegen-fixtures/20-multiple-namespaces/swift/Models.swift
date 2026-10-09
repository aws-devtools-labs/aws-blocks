import Foundation


public struct User: Codable {
    public let email: String
    public let id: String
    public let name: String

    public init(email: String, id: String, name: String) {
        self.email = email
        self.id = id
        self.name = name
    }
}