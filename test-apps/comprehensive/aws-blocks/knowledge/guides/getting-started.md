# Getting Started Guide

## Installation

Install the Blocks framework using npm. The Blocks package re-exports all Building Blocks so you only need a single dependency for most projects.

## Creating Your First App

Start by creating a Scope, which is the root container for all your Building Blocks. The Scope manages configuration, naming, and lifecycle for everything inside it.

## Adding a Knowledge Base

The KnowledgeBase Building Block lets you add semantic search to your application. Point it at a folder of documents and it will automatically index them for retrieval. In local development, it uses TF-IDF for keyword matching. In production, it uses Amazon Bedrock with vector embeddings for semantic search.

## Querying Documents

Use the retrieve method to search your knowledge base with natural language queries. Results include the matched text, a relevance score, the source document path, and any metadata associated with the document.

## Folder Organization

Organize your documents into subfolders to automatically assign metadata. For example, documents in a faq subfolder get metadata with folder set to faq. You can then filter results by folder to narrow search scope.

## Deployment

Blocks automatically handles deployment to AWS. Your local folder of documents gets synced to S3, and Bedrock Knowledge Bases handles chunking, embedding, and indexing. The retrieve API works identically in both local and production environments.
