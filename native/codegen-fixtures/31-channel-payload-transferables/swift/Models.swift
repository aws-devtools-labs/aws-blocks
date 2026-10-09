import Foundation
import BlocksRuntime


public struct Attachment: Codable {
    public let file: FileDownloadHandle
    public let name: String
    public let previews: [FileDownloadHandle]

    public init(file: FileDownloadHandle, name: String, previews: [FileDownloadHandle]) {
        self.file = file
        self.name = name
        self.previews = previews
    }
}

public struct Lobby: Codable {
    public let roomGroups: [RealtimeChannel<[RealtimeChannel<Note>]>]
    public let rooms: RealtimeChannel<[RealtimeChannel<Note>]>
    public let uploadsByRoom: [String: RealtimeChannel<FileUploadHandle>]

    public init(roomGroups: [RealtimeChannel<[RealtimeChannel<Note>]>], rooms: RealtimeChannel<[RealtimeChannel<Note>]>, uploadsByRoom: [String: RealtimeChannel<FileUploadHandle>]) {
        self.roomGroups = roomGroups
        self.rooms = rooms
        self.uploadsByRoom = uploadsByRoom
    }
}

public struct Note: Codable {
    public let id: String
    public let text: String

    public init(id: String, text: String) {
        self.id = id
        self.text = text
    }
}

public struct ProviderDirectory: Codable {
    public let title: String
    public let attributes: [String: OIDCClient]

    public init(title: String, attributes: [String: OIDCClient] = [:]) {
        self.title = title
        self.attributes = attributes
    }

    private struct DynamicKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }

    private static let fixedFieldNames: Set<String> = [
        "title",
    ]

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: DynamicKey.self)
        try c.encode(self.title, forKey: DynamicKey(stringValue: "title")!)
        for (k, v) in self.attributes where !Self.fixedFieldNames.contains(k) {
            try c.encode(v, forKey: DynamicKey(stringValue: k)!)
        }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicKey.self)
        self.title = try c.decode(String.self, forKey: DynamicKey(stringValue: "title")!)
        var extras: [String: OIDCClient] = [:]
        for key in c.allKeys where !Self.fixedFieldNames.contains(key.stringValue) {
            extras[key.stringValue] = try c.decode(OIDCClient.self, forKey: key)
        }
        self.attributes = extras
    }
}

public struct SignInBoard: Codable {
    public let clientsByTenant: [String: RealtimeChannel<[OIDCClient]>]
    public let feeds: [RealtimeChannel<SignInOption>]

    public init(clientsByTenant: [String: RealtimeChannel<[OIDCClient]>], feeds: [RealtimeChannel<SignInOption>]) {
        self.clientsByTenant = clientsByTenant
        self.feeds = feeds
    }
}

public struct SignInOption: Codable {
    public let client: OIDCClient
    public let label: String

    public init(client: OIDCClient, label: String) {
        self.client = client
        self.label = label
    }
}