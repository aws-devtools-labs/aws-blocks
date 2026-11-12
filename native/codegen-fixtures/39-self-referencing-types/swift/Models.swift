import Foundation


public nonisolated struct Category: Codable {
    public let name: String
    public let products: [Product]

    public init(name: String, products: [Product]) {
        self.name = name
        self.products = products
    }
}

public nonisolated struct Comment: Codable {
    public let replies: [Comment]?
    public let text: String

    enum CodingKeys: String, CodingKey {
        case replies
        case text
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.replies, forKey: .replies)
        try c.encode(self.text, forKey: .text)
    }

    public init(replies: [Comment]? = nil, text: String) {
        self.replies = replies
        self.text = text
    }
}

public nonisolated struct Product: Codable {
    public let categories: [Category]
    public let sku: String

    public init(categories: [Category], sku: String) {
        self.categories = categories
        self.sku = sku
    }
}

public nonisolated struct TreeNode: Codable {
    public let byName: [String: TreeNode]?
    public let children: [TreeNode]
    public let label: String

    enum CodingKeys: String, CodingKey {
        case byName
        case children
        case label
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(self.byName, forKey: .byName)
        try c.encode(self.children, forKey: .children)
        try c.encode(self.label, forKey: .label)
    }

    public init(byName: [String: TreeNode]? = nil, children: [TreeNode], label: String) {
        self.byName = byName
        self.children = children
        self.label = label
    }
}