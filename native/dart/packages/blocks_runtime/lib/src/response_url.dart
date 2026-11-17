import 'package:http/http.dart' as http;

/// A response paired with the URL it was received from.
typedef ResponseWithUrl = ({http.Response response, Uri url});

/// Sends a POST to [url] and returns the response with the URL it came from.
///
/// When the client follows redirects, the response (and its Set-Cookie
/// headers) belongs to the last URL in the chain rather than [url], so cookie
/// scope is derived from that URL. Clients that do not report the final URL
/// fall back to [url].
Future<ResponseWithUrl> postWithResponseUrl(
  http.Client client,
  Uri url, {
  Map<String, String>? headers,
  String? body,
}) async {
  final request = http.Request('POST', url);
  if (headers != null) request.headers.addAll(headers);
  if (body != null) request.body = body;
  final streamed = await client.send(request);
  final responseUrl = switch (streamed) {
    http.BaseResponseWithUrl(url: final finalUrl) => url.resolveUri(finalUrl),
    _ => url,
  };
  return (response: await http.Response.fromStream(streamed), url: responseUrl);
}
