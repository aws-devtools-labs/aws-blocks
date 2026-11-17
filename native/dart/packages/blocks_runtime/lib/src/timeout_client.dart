import 'dart:async';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'streams_request_body_web.dart'
    if (dart.library.io) 'streams_request_body_io.dart'
    as platform;

/// Default time allowed to connect, matching the other native runtimes.
const Duration defaultConnectTimeout = Duration(seconds: 30);

/// Default time a request may go without progress (no request bytes sent, no
/// response headers, or no response body bytes), matching the other native
/// runtimes. There is deliberately no cap on a request's total time, which
/// would cut off large file transfers.
const Duration defaultIdleTimeout = Duration(seconds: 60);

/// Replaces the defaults [newBlocksHttpClient] uses when it is not passed
/// explicit timeouts. Tests only; not exported.
({Duration connect, Duration idle})? debugHttpTimeoutsOverride;

/// The HTTP client the runtime uses when the caller does not pass one:
/// `http.Client()` (so `http.runWithClient` still picks the client) wrapped in
/// a [TimeoutClient].
http.Client newBlocksHttpClient({
  Duration? connectTimeout,
  Duration? idleTimeout,
}) => TimeoutClient(
  http.Client(),
  connectTimeout:
      connectTimeout ??
      debugHttpTimeoutsOverride?.connect ??
      defaultConnectTimeout,
  idleTimeout:
      idleTimeout ?? debugHttpTimeoutsOverride?.idle ?? defaultIdleTimeout,
);

/// Fails a request with a [TimeoutException] when it stops making progress.
///
/// On a client that reads the request body as it sends it (the default
/// dart:io client), [connectTimeout] bounds the wait until the client starts
/// reading the body, which it does once connected. After that,
/// [idleTimeout] bounds each wait: between two request body chunks, for the
/// response headers, and between two response body chunks while the response
/// is being read. A paused response stream does not count as a stall. On
/// timeout the request is aborted through [http.Abortable], for clients that
/// support it.
///
/// Other clients (the browser client, and clients such as `cupertino_http`
/// or `cronet_http` picked with `http.runWithClient`) read the whole body
/// before sending it, so neither connecting nor upload progress can be
/// observed and [connectTimeout] does not apply. On those, once the body has
/// been read, the response headers must arrive within [idleTimeout] plus the
/// time to send the body at [_minBytesPerSecond]. The response body is timed
/// the same way on every client.
class TimeoutClient extends http.BaseClient {
  TimeoutClient(
    this._inner, {
    required this.connectTimeout,
    required this.idleTimeout,
    bool? streamsRequestBody,
  }) : _streamsRequestBody =
           streamsRequestBody ?? platform.streamsRequestBody(_inner);

  final http.Client _inner;
  final Duration connectTimeout;
  final Duration idleTimeout;

  /// Whether [_inner] reads a request body as it sends it. Detected from the
  /// client type unless given.
  final bool _streamsRequestBody;

  /// Request bodies are passed on in slices of at most this many bytes, so a
  /// large upload shows progress as the transport takes each slice.
  static const int _sliceBytes = 64 * 1024;

  /// The slowest upload rate allowed for when the client gives no upload
  /// progress.
  static const int _minBytesPerSecond = 16 * 1024;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    final http.ByteStream source;
    try {
      source = request.finalize();
    } catch (error, stackTrace) {
      return Future.error(error, stackTrace);
    }
    final where = _describe(request.url);
    final result = Completer<http.StreamedResponse>();
    final abort = Completer<void>();
    final elapsed = Stopwatch()..start();
    var connected = false;
    Timer? timer;

    void fail(TimeoutException error) {
      timer?.cancel();
      if (!abort.isCompleted) abort.complete();
      if (!result.isCompleted) result.completeError(error);
    }

    void arm(Duration timeout) {
      timer?.cancel();
      timer = Timer(
        timeout,
        () => fail(TimeoutException('Request to $where stalled', timeout)),
      );
    }

    void onSlice() {
      if (result.isCompleted) return;
      if (_streamsRequestBody) {
        arm(idleTimeout);
      } else {
        timer?.cancel();
      }
    }

    void onEnd(int bytes) {
      if (result.isCompleted) return;
      if (_streamsRequestBody) {
        arm(idleTimeout);
      } else {
        final sendTime = Duration(
          microseconds:
              (request.contentLength ?? bytes) *
              Duration.microsecondsPerSecond ~/
              _minBytesPerSecond,
        );
        arm(idleTimeout + sendTime);
      }
    }

    timer = Timer(
      connectTimeout,
      () => fail(
        TimeoutException('Connecting to $where timed out', connectTimeout),
      ),
    );

    final body = _sliced(
      source,
      () {
        connected = true;
        onSlice();
      },
      onSlice,
      onEnd,
    );
    final forwarded = _ForwardedRequest(request, body, abort.future);

    Future.sync(() => _inner.send(forwarded)).then(
      (response) {
        if (result.isCompleted) {
          // Timed out already, on a client that ignores the abort.
          response.stream.listen(null).cancel().ignore();
          return;
        }
        timer?.cancel();
        result.complete(_withIdleBody(response, request, where, abort));
      },
      onError: (Object error, StackTrace stackTrace) {
        if (result.isCompleted) return;
        timer?.cancel();
        // A transport that enforces its own connect deadline fails at about
        // the same moment; report it the same way.
        if (!connected && elapsed.elapsed >= connectTimeout) {
          result.completeError(
            TimeoutException('Connecting to $where timed out', connectTimeout),
            stackTrace,
          );
        } else {
          result.completeError(error, stackTrace);
        }
      },
    );
    return result.future;
  }

  /// Re-emits [body] in slices of at most [_sliceBytes], calling [onListen]
  /// when the inner client starts reading it, [onSlice] as it takes each
  /// slice, and [onEnd] with the byte count when the body ends.
  static Stream<List<int>> _sliced(
    Stream<List<int>> body,
    void Function() onListen,
    void Function() onSlice,
    void Function(int bytes) onEnd,
  ) async* {
    onListen();
    var bytes = 0;
    await for (final chunk in body) {
      for (var start = 0; start < chunk.length; start += _sliceBytes) {
        final end = start + _sliceBytes < chunk.length
            ? start + _sliceBytes
            : chunk.length;
        onSlice();
        bytes += end - start;
        yield start == 0 && end == chunk.length
            ? chunk
            : chunk is Uint8List
            ? Uint8List.sublistView(chunk, start, end)
            : chunk.sublist(start, end);
      }
    }
    onEnd(bytes);
  }

  http.StreamedResponse _withIdleBody(
    http.StreamedResponse response,
    http.BaseRequest request,
    String where,
    Completer<void> abort,
  ) {
    final body = response.stream.timeout(
      idleTimeout,
      onTimeout: (sink) {
        if (!abort.isCompleted) abort.complete();
        sink
          ..addError(
            TimeoutException('Response from $where stalled', idleTimeout),
          )
          ..close();
      },
    );
    return _TimedResponse(
      body,
      response.statusCode,
      url: switch (response) {
        http.BaseResponseWithUrl(:final url) => url,
        _ => request.url,
      },
      contentLength: response.contentLength,
      request: request,
      headers: response.headers,
      isRedirect: response.isRedirect,
      persistentConnection: response.persistentConnection,
      reasonPhrase: response.reasonPhrase,
    );
  }

  /// The URL without its user info, query or fragment, any of which can
  /// hold a credential (a presigned URL's signature, for one).
  static String _describe(Uri url) => Uri(
    scheme: url.scheme,
    host: url.host,
    port: url.hasPort ? url.port : null,
    path: url.path,
  ).toString();

  @override
  void close() => _inner.close();
}

/// [request] with its body replaced by [_body] and an abort trigger added.
final class _ForwardedRequest extends http.BaseRequest with http.Abortable {
  _ForwardedRequest(http.BaseRequest request, this._body, this.abortTrigger)
    : super(request.method, request.url) {
    headers.addAll(request.headers);
    contentLength = request.contentLength;
    followRedirects = request.followRedirects;
    maxRedirects = request.maxRedirects;
    persistentConnection = request.persistentConnection;
  }

  final Stream<List<int>> _body;

  @override
  final Future<void> abortTrigger;

  @override
  http.ByteStream finalize() {
    super.finalize();
    return http.ByteStream(_body);
  }
}

/// A streamed response that keeps the inner response's final URL, which
/// cookie scoping reads after a redirect.
class _TimedResponse extends http.StreamedResponse
    implements http.BaseResponseWithUrl {
  _TimedResponse(
    super.stream,
    super.statusCode, {
    required this.url,
    super.contentLength,
    super.request,
    super.headers,
    super.isRedirect,
    super.persistentConnection,
    super.reasonPhrase,
  });

  @override
  final Uri url;
}
