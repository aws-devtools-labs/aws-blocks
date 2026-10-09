import 'transferable_descriptor.dart';

/// Fallback for a transferable whose tag has no runtime binding: holds the
/// [tag] and raw [descriptor] without hydrating them.
class UnknownTransferable {
  final String tag;

  /// The raw JSON descriptor (including its `__blocks` tag), stored by
  /// reference, not copied.
  final Map<String, dynamic> descriptor;

  UnknownTransferable._({required this.tag, required this.descriptor});

  /// Throws a [FormatException] unless [json] is an object whose `__blocks` is
  /// a non-empty string equal to [expectedTag].
  factory UnknownTransferable.fromJson(
    Object? json, {
    required String expectedTag,
  }) {
    if (json is! Map<String, dynamic>) {
      throw FormatException(
        "UnknownTransferable for '$expectedTag' expected a JSON object "
        'descriptor',
      );
    }
    final tag = json['__blocks'];
    if (tag is! String) {
      throw FormatException(
        "UnknownTransferable for '$expectedTag' expected a string "
        "'__blocks' tag",
      );
    }
    if (tag.isEmpty) {
      throw FormatException(
        "UnknownTransferable for '$expectedTag' expected a non-empty "
        "'__blocks' tag",
      );
    }
    if (tag != expectedTag) {
      throw FormatException(
        "UnknownTransferable expected tag '$expectedTag', got '$tag'",
      );
    }
    return UnknownTransferable._(tag: tag, descriptor: json);
  }

  /// The raw [descriptor], as the server sent it. A generated client sends
  /// an unbound transferable this way; `jsonEncode` calls it too.
  ///
  /// Returns a copy, so changing it doesn't change [descriptor].
  Map<String, dynamic> toJson() => transferableDescriptor(tag, descriptor);
}
