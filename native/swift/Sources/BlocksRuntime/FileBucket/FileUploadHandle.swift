//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation
import os

private let logger = Logger(subsystem: "com.aws.blocks.swift", category: "FileUploadHandle")

/// A live client-side object backed by a presigned upload URL.
/// Hydrated from a server descriptor containing the URL and optional content type.
///
/// Usage:
/// ```swift
/// let handle = try await client.getUploadUrl(filename: "photo.jpg")
/// try await handle.upload(data: imageData)
/// // or stream from disk:
/// try await handle.uploadFrom(fileURL: localPath)
/// ```
public final class FileUploadHandle: Sendable {
    private let url: String
    private let contentType: String?
    private let session: URLSession

    public init(url: String, contentType: String? = nil, session: URLSession? = nil) {
        self.url = url
        self.contentType = contentType
        self.session = session ?? BlocksRuntimeSession.shared
    }

    /// Hydrates a FileUploadHandle from a JSON descriptor.
    ///
    /// Expected shape: `{ "url": "https://s3.../presigned-url", "contentType": "image/jpeg" }`
    public static func fromJSON(_ json: [String: Any]) throws -> FileUploadHandle {
        let (url, contentType) = try parts(of: json)
        return FileUploadHandle(url: url, contentType: contentType)
    }

    /// The presigned URL and content type a descriptor carries.
    static func parts(of json: [String: Any]) throws -> (url: String, contentType: String?) {
        guard let url = json["url"] as? String else {
            throw FileBucketError.invalidURL("missing 'url' in descriptor")
        }
        return (url, json["contentType"] as? String)
    }

    /// Returns the presigned upload URL.
    public func getUrl() -> String { url }

    /// Uploads data to the presigned URL.
    ///
    /// - Parameter body: The file content to upload.
    /// - Throws: `FileBucketError.uploadFailed` on HTTP errors or network failures.
    public func upload(data body: Data) async throws {
        guard let requestURL = URL(string: url) else {
            throw FileBucketError.invalidURL(url)
        }

        var request = URLRequest(url: requestURL)
        request.httpMethod = "PUT"
        request.httpBody = body

        if let contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }

        do {
            let (_, response) = try await session.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw FileBucketError.uploadFailed("Invalid response", nil)
            }

            guard (200 ..< 300).contains(httpResponse.statusCode) else {
                throw FileBucketError.uploadFailed("HTTP \(httpResponse.statusCode)", nil)
            }

            logger.debug("Uploaded \(body.count) bytes to \(requestURL)")
        } catch let error as FileBucketError {
            throw error
        } catch {
            throw FileBucketError.uploadFailed(error.localizedDescription, error)
        }
    }

    /// Uploads a file from disk to the presigned URL.
    ///
    /// - Parameter fileURL: The local file URL to upload.
    /// - Throws: `FileBucketError.uploadFailed` on HTTP errors or network failures.
    public func uploadFrom(fileURL: URL) async throws {
        guard let requestURL = URL(string: url) else {
            throw FileBucketError.invalidURL(url)
        }

        var request = URLRequest(url: requestURL)
        request.httpMethod = "PUT"

        if let contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }

        do {
            let (_, response) = try await session.upload(for: request, fromFile: fileURL)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw FileBucketError.uploadFailed("Invalid response", nil)
            }

            guard (200 ..< 300).contains(httpResponse.statusCode) else {
                throw FileBucketError.uploadFailed("HTTP \(httpResponse.statusCode)", nil)
            }

            logger.debug("Uploaded file \(fileURL.lastPathComponent) to \(requestURL)")
        } catch let error as FileBucketError {
            throw error
        } catch {
            throw FileBucketError.uploadFailed(error.localizedDescription, error)
        }
    }
}

// MARK: - Codable

extension FileUploadHandle: Codable {
    /// Hydrates a handle from its descriptor in a generated result, at any depth, as `fromJSON` does.
    public convenience init(from decoder: Decoder) throws {
        let (url, contentType) = try Self.parts(of: TransferableCoding.descriptor(from: decoder))
        self.init(url: url, contentType: contentType)
    }

    /// Always throws: transferables are read-only.
    public func encode(to encoder: Encoder) throws {
        throw TransferableCoding.readOnlyError(self, encoder)
    }
}
