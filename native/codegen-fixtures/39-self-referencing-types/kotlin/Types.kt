package com.example.app

import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.Serializable

@Serializable
public data class Category(
  public val name: String,
  public val products: List<Product>,
)

@Serializable
public data class Comment(
  public val text: String,
  public val replies: List<Comment>?,
)

@Serializable
public data class Product(
  public val sku: String,
  public val categories: List<Category>,
)

@Serializable
public data class TreeNode(
  public val label: String,
  public val children: List<TreeNode>,
  public val byName: Map<String, TreeNode>? = null,
)
