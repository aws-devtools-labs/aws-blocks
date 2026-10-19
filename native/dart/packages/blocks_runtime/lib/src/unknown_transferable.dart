import 'package:blocks_runtime/src/transferable_descriptor.dart';

/// Fallback for a direct-result transferable whose tag has no runtime binding
/// on this platform: holds the [tag] and raw [descriptor] without hydrating
/// them.
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
    final descriptor = validateTransferableDescriptor(
      json,
      expectedTag: expectedTag,
      subject: 'UnknownTransferable',
    );
    return UnknownTransferable._(tag: expectedTag, descriptor: descriptor);
  }
}
