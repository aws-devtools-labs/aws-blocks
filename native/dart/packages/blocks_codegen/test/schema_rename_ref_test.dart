import 'dart:convert';

import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:test/test.dart';

// The builder renames types after it resolves them: a schema whose one field
// has a generic shape (`{value}`) takes a generic name (`ValueResult`), Pass 3
// suffixes types that collide (`MakeResult2`), and Pass 4 makes names Dart
// identifiers. A `$ref` names a schema, so every rename has to reach it.
// Before this, only Pass 4 renames did: a `$ref` to a generically renamed
// schema, or to a schema Pass 3 suffixed, still named the schema, so its type
// was undeclared or another type. Pass 3 also rebuilt the type table from the
// named types only, so an alias schema (`UserId: string`) dropped out of it,
// and so did a nullable object schema's own class.

Map<String, dynamic> _ref(String name) => {
  r'$ref': '#/components/schemas/$name',
};

Map<String, dynamic> _object(Map<String, Object> properties) => {
  'type': 'object',
  'properties': properties,
  'required': properties.keys.toList(),
};

Map<String, dynamic> _param(String name, Map<String, dynamic> schema) => {
  'name': name,
  'required': true,
  'schema': schema,
};

/// `a.make` and `b.make` both name their (different) inline results
/// `MakeResult`, which Pass 3 auto-disambiguates.
final _collidingResults = [
  {
    'name': 'b.make',
    'params': <Object>[],
    'result': {
      'name': 'MakeResult',
      'schema': _object({
        'y': {'type': 'integer'},
      }),
    },
  },
];

String _spec({bool collide = false, bool schemaNamedLikeResult = false}) =>
    jsonEncode({
      'openrpc': '1.3.2',
      'info': {'title': 't', 'version': '1'},
      'methods': [
        {
          'name': 'a.make',
          'params': [
            _param('id', _ref('UserId')),
            _param('tags', _ref('Tags')),
            _param('alias', _ref('IdAlias')),
            _param('w', _ref('Wrapper')),
            _param('ws', {'type': 'array', 'items': _ref('Wrapper')}),
            _param('m', _ref('MaybeBox')),
            _param('h', _ref('Holder')),
            if (schemaNamedLikeResult) _param('s', _ref('MakeResult')),
          ],
          'result': {
            'name': 'MakeResult',
            'schema': _object({
              'x': {'type': 'string'},
            }),
          },
        },
        if (collide) ..._collidingResults,
      ],
      'components': {
        'schemas': {
          'UserId': {'type': 'string'},
          'Tags': {
            'type': 'array',
            'items': {'type': 'string'},
          },
          'IdAlias': _ref('UserId'),
          'Wrapper': _object({
            'value': {'type': 'string'},
          }),
          'MaybeBox': {
            'oneOf': [
              _object({
                'n': {'type': 'integer'},
              }),
              {'type': 'null'},
            ],
          },
          'Holder': _object({
            'id': _ref('UserId'),
            'w': _ref('Wrapper'),
            'm': _ref('MaybeBox'),
          }),
          if (schemaNamedLikeResult)
            'MakeResult': _object({
              'z': {'type': 'boolean'},
            }),
        },
      },
    });

CodegenModel _build(String spec) =>
    CodegenModelBuilder().build(const OpenRpcParser().parse(spec));

String _generate(CodegenModel model) =>
    const DartCodeGenerator().generate(model);

/// Every `$ref` in [model], at any depth.
List<SchemaReference> _refs(CodegenModel model) {
  final refs = <SchemaReference>[];
  final seen = Set<ResolvedType>.identity();
  void walk(ResolvedType t) {
    if (!seen.add(t)) return;
    switch (t) {
      case SchemaReference():
        refs.add(t);
      case NullableType(inner: final i) || ListType(items: final i):
        walk(i);
      case MapType(valueType: final v):
        walk(v);
      case TupleType(items: final items):
        items.forEach(walk);
      case TransferableType(typeArgs: final args):
        args.forEach(walk);
      case RecordType(fields: final fields, additionalProperties: final ap):
        for (final f in fields) {
          walk(f.type);
        }
        if (ap != null) walk(ap);
      case SealedClassType(variants: final variants):
        for (final v in variants) {
          for (final f in v.fields) {
            walk(f.type);
          }
          if (v.embeddedUnion case final e?) walk(e);
          if (v.additionalProperties case final ap?) walk(ap);
        }
      case PrimitiveType() || EnumType():
        break;
    }
  }

  model.types.values.forEach(walk);
  for (final ns in model.namespaces) {
    for (final op in ns.operations) {
      walk(op.result);
      for (final p in op.params) {
        walk(p.type);
      }
    }
  }
  return refs;
}

String _signature(String output) {
  final i = output.indexOf('Future<MakeResult> make(');
  expect(i, isNot(-1));
  return output.substring(i, output.indexOf('\n', i));
}

void main() {
  for (final collide in [false, true]) {
    group(collide ? 'with a naming collision' : 'without a collision', () {
      final model = _build(_spec(collide: collide));
      final output = _generate(model);

      test('a collision is auto-disambiguated only when there is one', () {
        expect(
          model.warnings.any((w) => w.contains('generate `MakeResult`')),
          collide,
        );
      });

      test('every `\$ref` names an entry of the type table', () {
        for (final ref in _refs(model)) {
          expect(model.types, contains(ref.name), reason: ref.name);
        }
      });

      test('an alias schema stays an alias: its `\$ref` uses its type', () {
        expect(
          _signature(output),
          contains(
            'required String id, required List<String> tags, '
            'required String alias',
          ),
        );
        expect(output, isNot(contains('UserId')));
        expect(output, isNot(contains('IdAlias')));
      });

      test('a `\$ref` to a generically named schema names its class', () {
        expect(output, contains('class ValueResult {'));
        expect(
          _signature(output),
          contains('required ValueResult w, required List<ValueResult> ws'),
        );
        expect(output, contains("      w: ValueResult.fromJson(json['w']"));
        expect(output, isNot(contains('Wrapper')));
      });

      test('a nullable object schema keeps its class and its `?`', () {
        expect(output, contains('class MaybeBox {'));
        expect(_signature(output), contains('required MaybeBox? m'));
        expect(output, contains('  final MaybeBox? m;'));
      });
    });
  }

  test('a `\$ref` to a schema Pass 3 renamed follows the schema', () {
    // The schema `MakeResult` (`{z}`) collides with both inline results; the
    // smallest source key (`a.make (result)`) keeps the base name, so the
    // schema becomes `MakeResult3`. Its `$ref` used to name `MakeResult`:
    // `a.make`'s result, a different type.
    final model = _build(_spec(collide: true, schemaNamedLikeResult: true));
    final output = _generate(model);
    final param = model.namespaces
        .expand((ns) => ns.operations)
        .firstWhere((op) => op.fullName == 'a.make')
        .params
        .firstWhere((p) => p.name == 's');
    final target = model.types[(param.type as SchemaReference).name];
    expect(target, isA<RecordType>());
    expect((target as RecordType).fields.map((f) => f.name), ['z']);
    expect(_signature(output), contains('required ${target.name} s'));
    expect(target.name, isNot('MakeResult'));
  });

  test('a `\$ref` to a model keeps its name (guard)', () {
    final output = _generate(_build(_spec()));
    expect(output, contains('class Holder {'));
    expect(_signature(output), contains('required Holder h'));
  });
}
