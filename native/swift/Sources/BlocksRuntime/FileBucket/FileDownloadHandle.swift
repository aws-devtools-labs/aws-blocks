//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation
import os

private let logger = Logger(subsystem: "com.aws.blocks.swift", category: "FileDownloadHandle")

/// A live client-side object backed by a presigned download URL.
/// Hydrated from a server descriptor containing the URL.
///
/// Usage:
/// ```swift
/// let handle = try await client.getFile(fileId: "abc")
/// let data = try await handle.download()
/// // or stream to disk:
/// try await handle.downloadTo(fileURL: localPath)
/// ```
public class FileDownloadHandle {
    private let url: String
    private let session: URLSession

    public init(url: String, session: URLSession? = nil) {
        self.url = url
        self.session = session ?? BlocksRuntimeSession.shared
    }

    /// Hydrates a FileDownloadHandle from a JSON descriptor.
    ///
    /// Expected shape: `{ "url": "https://s3.../presigned-url" }`
    public static func fromJSON(_ json: [String: Any]) throws -> FileDownloadHandle {
        guard let url = json["url"] as? String else {
            throw FileBucketError.invalidURL("missing 'url' in descriptor")
        }
        return FileDownloadHandle(url: url)
    }

    private enum DescriptorKeys: String, CodingKey {
        case blocksType = "__blocks"
        case url
    }

    /// Decodes a handle from its `{ "__blocks": "file-bucket/download", "url": … }` descriptor, so a generated
    /// model can hold one in a field, an array, a dictionary or an optional.
    public required convenience init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DescriptorKeys.self)
        try TransferableDescriptor.check(container, key: .blocksType, expected: "file-bucket/download")
        self.init(url: try container.decode(String.self, forKey: .url))
    }

    /// Encodes the handle's descriptor, as the server's `toJSON()` sends it:
    /// `{ "__blocks": "file-bucket/download", "url" }`.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DescriptorKeys.self)
        try container.encode("file-bucket/download", forKey: .blocksType)
        try container.encode(url, forKey: .url)
    }

    /// Returns the presigned download URL.
    public func getUrl() -> String { url }

    /// Downloads the file content into memory.
    ///
    /// - Returns: The file content as `Data`.
    /// - Throws: `FileBucketError.downloadFailed` on HTTP errors or network failures.
    public func download() async throws -> Data {
        guard let requestURL = URL(string: url) else {
            throw FileBucketError.invalidURL(url)
        }

        do {
            let (data, response) = try await session.data(from: requestURL)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw FileBucketError.downloadFailed("Invalid response", nil)
            }

            guard (200 ..< 300).contains(httpResponse.statusCode) else {
                throw FileBucketError.downloadFailed("HTTP \(httpResponse.statusCode)", nil)
            }

            logger.debug("Downloaded \(data.count) bytes from \(requestURL)")
            return data
        } catch let error as FileBucketError {
            throw error
        } catch {
            throw FileBucketError.downloadFailed(error.localizedDescription, error)
        }
    }

    /// Downloads the file content directly to a file on disk.
    ///
    /// - Parameter fileURL: The local file URL to write to.
    /// - Throws: `FileBucketError.downloadFailed` on HTTP errors or network failures.
    public func downloadTo(fileURL: URL) async throws {
        guard let requestURL = URL(string: url) else {
            throw FileBucketError.invalidURL(url)
        }

        do {
            let (tempURL, response) = try await session.download(from: requestURL)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw FileBucketError.downloadFailed("Invalid response", nil)
            }

            guard (200 ..< 300).contains(httpResponse.statusCode) else {
                throw FileBucketError.downloadFailed("HTTP \(httpResponse.statusCode)", nil)
            }

            // Move temp file to destination
            let fileManager = FileManager.default
            if fileManager.fileExists(atPath: fileURL.path) {
                try fileManager.removeItem(at: fileURL)
            }
            try fileManager.moveItem(at: tempURL, to: fileURL)

            logger.debug("Downloaded to \(fileURL.path)")
        } catch let error as FileBucketError {
            throw error
        } catch {
            throw FileBucketError.downloadFailed(error.localizedDescription, error)
        }
    }
}

extension FileDownloadHandle: Codable {}
