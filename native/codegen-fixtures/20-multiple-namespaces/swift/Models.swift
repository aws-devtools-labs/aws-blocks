import Foundation


public nonisolated struct User: Codable {
    public let email: String
    public let id: String
    public let name: String
}