import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

/// Whether [client] reads a request body as it sends it, so the pace at which
/// it takes body chunks reflects upload progress. `IOClient` does.
bool streamsRequestBody(http.Client client) => client is IOClient;
