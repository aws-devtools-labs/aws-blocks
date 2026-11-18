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
        guard let url = json["url"] as? String else {
            throw TransferableError.invalidDescriptor(blocksType: "file-bucket/upload", missingField: "url")
        }
        let contentType = json["contentType"] as? String
        return FileUploadHandle(url: url, contentType: contentType)
    }

    private enum DescriptorKeys: String, CodingKey {
        case blocksType = "__blocks"
        case url
        case contentType
    }

    /// Decodes a handle from its `{ "__blocks": "file-bucket/upload", "url": …, "contentType"?: … }` descriptor,
    /// so a generated model can hold one in a field, an array, a dictionary or an optional.
    public required convenience init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DescriptorKeys.self)
        try TransferableDescriptor.check(container, key: .blocksType, expected: "file-bucket/upload")
        self.init(
            url: try container.decode(String.self, forKey: .url),
            contentType: try container.decodeIfPresent(String.self, forKey: .contentType)
        )
    }

    /// Always throws `EncodingError.invalidValue`: transferables are read-only. The conformance exists so a
    /// generated `Codable` model that holds a handle compiles.
    public func encode(to encoder: Encoder) throws {
        throw TransferableDescriptor.readOnly(self, tag: "file-bucket/upload", encoder: encoder)
    }

    /// Returns the presigned upload URL.
    public func getUrl() -> String { url }

    /// Uploads data to the presigned URL.
    ///
    /// - Parameter body: The file content to upload.
    /// - Throws: `FileTransferError` on HTTP errors or network failures, carrying the HTTP status in
    ///   `statusCode`; `TransferableError` if the handle's URL cannot be parsed.
    public func upload(data body: Data) async throws {
        guard let requestURL = URL(string: url) else {
            throw TransferableError.invalidDescriptor(blocksType: "file-bucket/upload", missingField: "url")
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
                throw FileTransferError(message: "Upload failed: invalid response")
            }

            guard (200 ..< 300).contains(httpResponse.statusCode) else {
                throw FileTransferError(
                    message: "Upload failed: HTTP \(httpResponse.statusCode)",
                    statusCode: httpResponse.statusCode
                )
            }

            // The presigned URL's query string is its credential, so only scheme, host and path are logged.
            logger.debug("Uploaded \(body.count) bytes to \(requestURL.redactedForLogging)")
        } catch let error as FileTransferError {
            throw error
        } catch let error as TransferableError {
            throw error
        } catch let error as CancellationError {
            throw error
        } catch let error as URLError where error.code == .cancelled && Task.isCancelled {
            // A cancelled calling task, as `SessionGate.send` reports it.
            throw CancellationError()
        } catch {
            throw FileTransferError(
                message: "Upload failed: \(error.localizedDescription)",
                statusCode: nil,
                underlyingError: error
            )
        }
    }

    /// Uploads a file from disk to the presigned URL.
    ///
    /// The request's `Content-Length` is the file's size. If the handle was
    /// created on the server with a `contentLength` option, that size is signed
    /// into the URL and the upload is rejected unless the file is exactly that
    /// many bytes.
    ///
    /// - Parameter fileURL: The local file URL to upload.
    /// - Throws: `FileTransferError` on HTTP errors or network failures, carrying the HTTP status in
    ///   `statusCode`; `TransferableError` if the handle's URL cannot be parsed.
    public func uploadFrom(fileURL: URL) async throws {
        guard let requestURL = URL(string: url) else {
            throw TransferableError.invalidDescriptor(blocksType: "file-bucket/upload", missingField: "url")
        }

        var request = URLRequest(url: requestURL)
        request.httpMethod = "PUT"

        if let contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }

        do {
            let (_, response) = try await session.upload(for: request, fromFile: fileURL)

            guard let httpResponse = response as? HTTPURLResponse else {
                throw FileTransferError(message: "Upload failed: invalid response")
            }

            guard (200 ..< 300).contains(httpResponse.statusCode) else {
                throw FileTransferError(
                    message: "Upload failed: HTTP \(httpResponse.statusCode)",
                    statusCode: httpResponse.statusCode
                )
            }

            logger.debug("Uploaded file \(fileURL.lastPathComponent) to \(requestURL.redactedForLogging)")
        } catch let error as FileTransferError {
            throw error
        } catch let error as TransferableError {
            throw error
        } catch let error as CancellationError {
            throw error
        } catch let error as URLError where error.code == .cancelled && Task.isCancelled {
            // A cancelled calling task, as `SessionGate.send` reports it.
            throw CancellationError()
        } catch {
            throw FileTransferError(
                message: "Upload failed: \(error.localizedDescription)",
                statusCode: nil,
                underlyingError: error
            )
        }
    }
}

extension FileUploadHandle: Codable {}
