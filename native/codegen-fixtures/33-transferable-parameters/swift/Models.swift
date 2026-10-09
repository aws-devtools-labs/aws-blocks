import Foundation
import BlocksRuntime


public struct Bundle: Codable {
    public let feed: RealtimeChannel<Note>
    public let files: [FileDownloadHandle]
    public let upload: FileUploadHandle?

    enum CodingKeys: String, CodingKey {
        case feed
        case files
        case upload
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(self.feed, forKey: .feed)
        try c.encode(self.files, forKey: .files)
        try c.encodeIfPresent(self.upload, forKey: .upload)
    }

    public init(feed: RealtimeChannel<Note>, files: [FileDownloadHandle], upload: FileUploadHandle? = nil) {
        self.feed = feed
        self.files = files
        self.upload = upload
    }
}

public struct Note: Codable {
    public let body: String
    public let id: String

    public init(body: String, id: String) {
        self.body = body
        self.id = id
    }
}