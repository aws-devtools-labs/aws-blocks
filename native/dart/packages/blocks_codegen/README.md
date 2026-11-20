# blocks_codegen

Code generator for the AWS CDK Blocks Dart SDK. Reads an OpenRPC spec and writes one Dart file: an API class per namespace, a `Blocks` facade, models, sealed classes for unions, and enums.

## Usage

### CLI

```bash
dart run blocks_codegen --spec path/to/spec.json --output lib/blocks_client.dart
```

### build_runner

Add `blocks_codegen` and `build_runner` to `dev_dependencies` and put the backend's `blocks.spec.json` in `lib/`. The builder applies itself to every package that depends on `blocks_codegen`, and turns each `*.spec.json` file into a `*.blocks.dart` file next to it, so `lib/blocks.spec.json` becomes `lib/blocks.blocks.dart`. Run:

```bash
dart run build_runner build
```

### Options

| CLI flag | `build.yaml` option | Default | Description |
|----------|---------------------|---------|-------------|
| `--spec`, `-s` | none | required | The spec to read. The builder reads every `*.spec.json` file instead. |
| `--output`, `-o` | none | standard output | Where to write the Dart file. The builder writes `*.blocks.dart` next to the spec. |
| `--fail-on-collision` | `fail_on_collision` | `false` | Makes a name collision an error. By default the codegen renames one of the two names and warns (see [Generated names](#generated-names)). |
| `--native-package-opt-out` (repeatable) | `native_package_opt_out` | none | Logical identities from `x-blocks-native-packages` whose results stay `UnknownTransferable` instead of the declared type. An identity the spec doesn't declare opts nothing out and is reported as `AWSBLOCKS-NATIVE-006`. |

The builder needs no `build.yaml`. To set its options, add one to the app:

```yaml
targets:
  $default:
    builders:
      blocks_codegen|blocks_codegen:
        options:
          fail_on_collision: true
```

## Generated names

Dart declares a union's arm classes at the top level, named `<Value><Suffix>`
(`signUp` in an `…Input` union is `SignUpInput`). When two distinct unions
have an arm of one name:

- The union with the smallest origin keeps the name. An origin key is
  `schema:<Name>` for a schema, `<method>#param:<name>` or `<method>#result`
  for an inline union, over every namespace that declares the union.
- Every `schema:` key ranks before every method key, and keys of one kind
  compare as strings, so spec order never decides.
- The other union's arm takes its namespace's prefix
  (`AuthCognitoApiSignUpInput`), or, when that is taken or the union is a
  `$ref` schema, its union's name (`AuthInputSignUp`).
- A union added later with a smaller origin (an `authApi` namespace beside
  `authCognitoApi`) takes the short name over, renaming the other union's arm.
- The codegen warns about each rename; pass `--fail-on-collision` to make it
  an error.
- To pin the short name on a union, declare it as a named schema.

A method whose result is an OIDC client that names its providers gets a
provider enum named `<Api class><Method>Provider` (`AuthApiGetClientProvider`
for `auth.getClient`, and for `auth.get_client`) and returns
`TypedOidcClient<AuthApiGetClientProvider>`. When the library already declares
that name, the enum is `<Api class><Method>ResultProvider` and the codegen
warns. A provider name that isn't an identifier is camel-cased like an enum
value (`login.gov` is `loginGov`) and keeps its name as the value's
`providerName`. `TypedOidcClient` is described in the `blocks_runtime` README
under [Typed OIDC providers](../blocks_runtime/README.md#typed-oidc-providers).

## License

Apache 2.0
