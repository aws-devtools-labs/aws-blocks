//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import SwiftUI
import UniformTypeIdentifiers
import BlocksRuntime

// MARK: - File Transfer View
// File transfer demo view.
// Upload/download files via presigned URLs using FileUploadHandle/FileDownloadHandle.

struct FileTransferView: View {
    @EnvironmentObject var appState: AppState
    @State private var path = "test/hello.txt"
    @State private var status = ""
    @State private var downloadedContent: DownloadedContent?
    @State private var selectedFileData: Data?
    @State private var selectedFileName: String?
    @State private var showFilePicker = false

    var body: some View {
        List {
            // Path input
            Section("File Path") {
                TextField("e.g. uploads/photo.jpg", text: $path)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
            }

            // Upload section
            Section("Upload") {
                Button {
                    showFilePicker = true
                } label: {
                    Label(selectedFileName ?? "Choose File", systemImage: "doc.badge.plus")
                }

                Button {
                    Task { await upload() }
                } label: {
                    Label("Upload", systemImage: "arrow.up.circle.fill")
                }
                .disabled(selectedFileData == nil || path.isEmpty)
            }
            .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.item]) { result in
                switch result {
                case .success(let url):
                    guard url.startAccessingSecurityScopedResource() else { return }
                    defer { url.stopAccessingSecurityScopedResource() }
                    selectedFileData = try? Data(contentsOf: url)
                    selectedFileName = url.lastPathComponent
                case .failure:
                    break
                }
            }

            // Download section
            Section("Download") {
                Button {
                    Task { await download() }
                } label: {
                    Label("Download", systemImage: "arrow.down.circle.fill")
                }
                .disabled(path.isEmpty)
            }

            // Status
            if !status.isEmpty {
                Section("Status") {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(status.hasPrefix("Error") ? .red : .green)
                }
            }

            // Preview
            if let content = downloadedContent {
                Section("Preview") {
                    switch content {
                    case .image(let data):
                        if let uiImage = UIImage(data: data) {
                            Image(uiImage: uiImage)
                                .resizable()
                                .scaledToFit()
                                .frame(maxHeight: 200)
                        }
                    case .text(let string):
                        Text(string)
                            .font(.system(.caption, design: .monospaced))
                    case .binary(let size):
                        Text("Binary file: \(size) bytes")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    // MARK: - Actions

    private func upload() async {
        guard let data = selectedFileData else {
            status = "Error: No file selected"
            return
        }
        guard !path.isEmpty else {
            status = "Error: Enter a file path"
            return
        }

        status = "Uploading..."
        do {
            let handle = try await appState.api.getUploadHandle(path: path, contentType: mimeType(for: path))
            try await handle.upload(data: data)
            status = "Uploaded \(data.count) bytes to \(path)"
        } catch {
            status = "Error: \(error.localizedDescription)"
        }
    }

    private func download() async {
        guard !path.isEmpty else {
            status = "Error: Enter a file path"
            return
        }

        status = "Downloading..."
        downloadedContent = nil
        do {
            let handle = try await appState.api.getDownloadHandle(path: path)
            let data = try await handle.download()

            let lower = path.lowercased()
            if lower.hasSuffix(".png") || lower.hasSuffix(".jpg") ||
               lower.hasSuffix(".jpeg") || lower.hasSuffix(".gif") ||
               lower.hasSuffix(".webp") {
                downloadedContent = .image(data)
                status = "Downloaded image (\(data.count) bytes)"
            } else if lower.hasSuffix(".txt") || lower.hasSuffix(".json") ||
                      lower.hasSuffix(".md") || lower.hasSuffix(".csv") {
                let text = String(data: data, encoding: .utf8) ?? "(binary)"
                downloadedContent = .text(text)
                status = "Downloaded text (\(text.count) chars)"
            } else {
                downloadedContent = .binary(data.count)
                status = "Downloaded \(data.count) bytes"
            }
        } catch {
            status = "Error: \(error.localizedDescription)"
        }
    }

    private func mimeType(for path: String) -> String {
        let lower = path.lowercased()
        if lower.hasSuffix(".jpg") || lower.hasSuffix(".jpeg") { return "image/jpeg" }
        if lower.hasSuffix(".png") { return "image/png" }
        if lower.hasSuffix(".gif") { return "image/gif" }
        if lower.hasSuffix(".webp") { return "image/webp" }
        if lower.hasSuffix(".pdf") { return "application/pdf" }
        if lower.hasSuffix(".txt") { return "text/plain" }
        if lower.hasSuffix(".json") { return "application/json" }
        return "application/octet-stream"
    }
}

// MARK: - Downloaded Content

private enum DownloadedContent {
    case image(Data)
    case text(String)
    case binary(Int)
}
