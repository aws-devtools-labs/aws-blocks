// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

class Product {
  final String sku;
  final List<Category> categories;

  const Product({
    required this.sku,
    required this.categories,
  });

  factory Product.fromJson(Map<String, dynamic> json) {
    return Product(
      sku: json['sku'] as String,
      categories: (json['categories'] as List<dynamic>).map((e) => Category.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'sku': sku,
      'categories': categories.map((e) => e.toJson()).toList(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Product &&
          sku == other.sku &&
          blocksDeepEquals(categories, other.categories);

  @override
  int get hashCode => Object.hash(sku, blocksDeepHash(categories));

  @override
  String toString() => 'Product(sku: $sku, categories: $categories)';
}


// --- API Namespaces ---

class TreeNode {
  final String label;
  final List<TreeNode> children;
  final Map<String, TreeNode>? byName;

  const TreeNode({
    required this.label,
    required this.children,
    this.byName,
  });

  factory TreeNode.fromJson(Map<String, dynamic> json) {
    return TreeNode(
      label: json['label'] as String,
      children: (json['children'] as List<dynamic>).map((e) => TreeNode.fromJson(e as Map<String, dynamic>)).toList(),
      byName: (json['byName'] as Map<String, dynamic>?)?.map((k, v) => MapEntry(k, TreeNode.fromJson(v as Map<String, dynamic>))),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'label': label,
      'children': children.map((e) => e.toJson()).toList(),
      if (byName != null) 'byName': byName?.map((k, v) => MapEntry(k, v.toJson())),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is TreeNode &&
          label == other.label &&
          blocksDeepEquals(children, other.children) &&
          blocksDeepEquals(byName, other.byName);

  @override
  int get hashCode => Object.hash(label, blocksDeepHash(children), blocksDeepHash(byName));

  @override
  String toString() => 'TreeNode(label: $label, children: $children, byName: $byName)';
}


class Comment {
  final String text;
  final List<Comment>? replies;

  const Comment({
    required this.text,
    required this.replies,
  });

  factory Comment.fromJson(Map<String, dynamic> json) {
    return Comment(
      text: json['text'] as String,
      replies: (json['replies'] as List<dynamic>?)?.map((e) => Comment.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'text': text,
      'replies': replies?.map((e) => e.toJson()).toList(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Comment &&
          text == other.text &&
          blocksDeepEquals(replies, other.replies);

  @override
  int get hashCode => Object.hash(text, blocksDeepHash(replies));

  @override
  String toString() => 'Comment(text: $text, replies: $replies)';
}


class Category {
  final String name;
  final List<Product> products;

  const Category({
    required this.name,
    required this.products,
  });

  factory Category.fromJson(Map<String, dynamic> json) {
    return Category(
      name: json['name'] as String,
      products: (json['products'] as List<dynamic>).map((e) => Product.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'name': name,
      'products': products.map((e) => e.toJson()).toList(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Category &&
          name == other.name &&
          blocksDeepEquals(products, other.products);

  @override
  int get hashCode => Object.hash(name, blocksDeepHash(products));

  @override
  String toString() => 'Category(name: $name, products: $products)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<TreeNode> getTree({required TreeNode root}) async {
    final params = <dynamic>[
      root.toJson(),
    ];
    final result = await _client.call('api.getTree', params);
    return TreeNode.fromJson(result as Map<String, dynamic>);
  }

  Future<Comment> getThread() async {
    final result = await _client.call('api.getThread', const <dynamic>[]);
    return Comment.fromJson(result as Map<String, dynamic>);
  }

  Future<Category?> getCategory() async {
    final result = await _client.call('api.getCategory', const <dynamic>[]);
    return result == null ? null : Category.fromJson(result as Map<String, dynamic>);
  }
}


// --- Blocks Client ---

class Blocks {
  late final ApiApi api;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    api = ApiApi(client);
  }
}

