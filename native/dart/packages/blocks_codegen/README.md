# blocks_codegen

Code generator for the Blocks Dart SDK. Reads an OpenRPC spec and generates a fully typed Dart client with sealed classes, enums, maps, and transferable hydration.

## Usage

### CLI

```bash
dart run blocks_codegen --spec path/to/spec.json --output lib/blocks_client.dart
```

### build_runner

Add to `build.yaml` and place your `.spec.json` in `lib/`. Run:

```bash
dart run build_runner build
```

## Generated names

Dart declares a union's arm classes at the top level, named `<Value><Suffix>`
(`signUp` in an `…Input` union is `SignUpInput`). When two distinct unions
have an arm of one name, the union with the smallest origin keeps it: its
origins' keys (`schema:<Name>` for a schema, `<method>#param:<name>` or
`<method>#result` for an inline union, over every namespace that declares
it) compared as strings, so spec order never decides. The other union's arm
takes its namespace's prefix (`AuthCognitoApiSignUpInput`), or, when that is
taken or the union is a `$ref` schema, its union's name
(`AuthInputSignUp`). A union added later with a smaller origin (an `authApi`
namespace beside `authCognitoApi`) takes the short name over, renaming the
other union's arm. The codegen warns about each rename; pass
`--fail-on-collision` to make it an error.

## License

Apache 2.0
