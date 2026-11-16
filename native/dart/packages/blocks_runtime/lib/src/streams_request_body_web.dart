import 'package:http/http.dart' as http;

/// Whether [client] reads a request body as it sends it. The browser client
/// reads the whole body first, and other clients are not known to stream.
bool streamsRequestBody(http.Client client) => false;
