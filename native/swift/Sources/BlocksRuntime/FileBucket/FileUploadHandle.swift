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
public class FileUploadHandle {
    private let url: String
    private let contentType: String?
    private let session: URLSession

    public init(url: String, contentType: String? = nil, session: URLSession = .shared) {
        self.url = url
        self.contentType = contentType
        self.session = session
    }

    /// Hydrates a FileUploadHandle from a JSON descriptor.
    ///
    /// Expected shape: `{ "url": "https://s3.../presigned-url", "contentType": "image/jpeg" }`
    public static func fromJSON(_ json: [String: Any]) throws -> FileUploadHandle {
        guard let url = json["url"] as? String else {
            throw FileBucketError.invalidURL("missing 'url' in descriptor")
        }
        let contentType = json["contentType"] as? String
        return FileUploadHandle(url: url, contentType: contentType)
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
