import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:test/test.dart';

/// A stand-in for a generated model: value equality on its one field.
class _Note {
  const _Note(this.id);

  final String id;

  @override
  bool operator ==(Object other) => other is _Note && id == other.id;

  @override
  int get hashCode => id.hashCode;
}

void main() {
  group('blocksDeepEquals', () {
    test('lists with equal elements are equal, unlike List ==', () {
      final a = ['x', 'y'];
      final b = ['x', 'y'];
      expect(a == b, isFalse);
      expect(blocksDeepEquals(a, b), isTrue);
      expect(blocksDeepHash(a), blocksDeepHash(b));
    });

    test('list order and length matter', () {
      expect(blocksDeepEquals(['x', 'y'], ['y', 'x']), isFalse);
      expect(blocksDeepEquals(['x'], ['x', 'x']), isFalse);
    });

    test('maps with equal entries are equal in any order', () {
      final a = {'a': 1, 'b': 2};
      final b = {'b': 2, 'a': 1};
      expect(blocksDeepEquals(a, b), isTrue);
      expect(blocksDeepHash(a), blocksDeepHash(b));
      expect(blocksDeepEquals(a, {'a': 1, 'b': 3}), isFalse);
      expect(blocksDeepEquals(a, {'a': 1, 'c': 2}), isFalse);
      expect(blocksDeepEquals(a, {'a': 1}), isFalse);
    });

    test('a missing key is not the same as a null value', () {
      expect(blocksDeepEquals({'a': null}, {'b': null}), isFalse);
    });

    test('nested lists and maps of models compare by value', () {
      Map<String, List<_Note>> notesByTag() => {
        'work': [const _Note('1'), const _Note('2')],
        'home': [],
      };
      List<Map<String, _Note>> pages() => [
        {'a': const _Note('1')},
        {'b': const _Note('2')},
      ];
      expect(blocksDeepEquals(notesByTag(), notesByTag()), isTrue);
      expect(blocksDeepHash(notesByTag()), blocksDeepHash(notesByTag()));
      expect(blocksDeepEquals(pages(), pages()), isTrue);
      expect(blocksDeepHash(pages()), blocksDeepHash(pages()));
      expect(
        blocksDeepEquals(notesByTag(), {
          'work': [const _Note('1'), const _Note('3')],
          'home': <_Note>[],
        }),
        isFalse,
      );
    });

    test('null, primitives and nullable elements', () {
      expect(blocksDeepEquals(null, null), isTrue);
      expect(blocksDeepEquals(null, <String>[]), isFalse);
      expect(blocksDeepEquals(<String>[], null), isFalse);
      expect(blocksDeepEquals('a', 'a'), isTrue);
      expect(blocksDeepEquals(1, 2), isFalse);
      expect(
        blocksDeepEquals([null, const _Note('1')], [null, const _Note('1')]),
        isTrue,
      );
      expect(blocksDeepHash(null), null.hashCode);
      expect(blocksDeepHash('a'), 'a'.hashCode);
    });

    test('a list is not equal to a map', () {
      expect(blocksDeepEquals(<Object?>[], <String, Object?>{}), isFalse);
    });

    test('ignores the static element type', () {
      expect(blocksDeepEquals(<Object?>['a'], <String>['a']), isTrue);
      expect(blocksDeepHash(<Object?>['a']), blocksDeepHash(<String>['a']));
    });
  });
}
