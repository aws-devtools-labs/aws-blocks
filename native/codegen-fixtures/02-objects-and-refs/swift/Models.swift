import Foundation


public struct Todo: Codable {
    public let done: Bool
    public let id: String
    public let priority: Int
    public let title: String

    public init(done: Bool, id: String, priority: Int, title: String) {
        self.done = done
        self.id = id
        self.priority = priority
        self.title = title
    }
}