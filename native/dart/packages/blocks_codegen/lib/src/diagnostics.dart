/// Escaped so a spec-supplied string cannot split a one-line diagnostic into
/// several or forge one, nor split the generated header comment.
String escapeForDiagnostic(String value) =>
    value.replaceAll('\n', r'\n').replaceAll('\r', r'\r');
