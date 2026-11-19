import 'dart:io';

/// Writes [message] to standard error.
void writeSessionWarning(String message) => stderr.writeln(message);
