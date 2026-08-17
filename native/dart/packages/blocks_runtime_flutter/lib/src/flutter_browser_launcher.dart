import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:url_launcher/url_launcher.dart';

/// [BrowserLauncher] that opens the system browser and listens for
/// deep-link callbacks via [AppLinks].
///
/// In the server-relay OIDC flow the IdP's `redirect_uri` is the backend's
/// HTTPS callback, and the backend 302s back to the app via the `relayTo`
/// custom-scheme URI. The launcher captures that relay redirect by matching its
/// scheme (passed as [callbackScheme], the scheme of `relayTo`). On iOS this
/// surfaces as a universal/deep link delivered to `AppLinks`; on Android it is
/// the custom-scheme intent. The same code path handles both the relay flow and
/// the legacy direct custom-scheme flow.
///
/// Flutter's own deep linking is enabled by default and also delivers custom
/// schemes, so an app that routes deep links itself will see the callback as
/// well. That is harmless here, but such a router should ignore URIs whose
/// scheme is the OIDC [callbackScheme].
class FlutterBrowserLauncher implements BrowserLauncher {
  FlutterBrowserLauncher({
    AppLinks? appLinks,
    this.timeout = const Duration(minutes: 5),
  }) : _appLinks = appLinks ?? AppLinks();

  /// Bounded because a user who dismisses the browser produces no event at
  /// all, so an unbounded wait would hang the sign-in forever.
  final Duration timeout;

  final AppLinks _appLinks;

  bool _initialLinkConsumed = false;

  /// Throws [OidcCancelledException] if the redirect does not arrive within
  /// [timeout] or the link stream closes first, and [OidcCallbackException] if
  /// the browser could not be opened.
  @override
  Future<Uri> launch(Uri authorizeUrl, {required String callbackScheme}) async {
    // uriLinkStream is a broadcast stream, so a redirect arriving before the
    // subscription is attached would be dropped.
    final redirect = Completer<Uri>();
    final subscription = _appLinks.uriLinkStream
        .where((uri) => uri.scheme == callbackScheme)
        .listen(
          (uri) {
            if (!redirect.isCompleted) redirect.complete(uri);
          },
          onError: (Object error) {
            if (!redirect.isCompleted) {
              redirect.completeError(
                OidcCallbackException('Deep link stream failed: $error'),
              );
            }
          },
          onDone: () {
            if (!redirect.isCompleted) {
              redirect.completeError(OidcCancelledException());
            }
          },
        );
    // Early returns below leave this future unawaited; an error with no
    // listener becomes an unhandled async error.
    redirect.future.ignore();

    try {
      // The OS can kill the app while the browser is foregrounded and relaunch
      // it with the redirect, which then only arrives as the initial link.
      // Consumed once per instance so a later sign-in cannot replay a stale one.
      if (!_initialLinkConsumed) {
        _initialLinkConsumed = true;
        final initialLink = await _appLinks.getInitialLink();
        if (initialLink != null && initialLink.scheme == callbackScheme) {
          return initialLink;
        }
      }

      final opened = await launchUrl(
        authorizeUrl,
        mode: LaunchMode.externalApplication,
      );
      if (!opened) {
        throw OidcCallbackException('Could not open a browser: $authorizeUrl');
      }

      return await redirect.future.timeout(
        timeout,
        onTimeout: () => throw OidcCancelledException(),
      );
    } finally {
      await subscription.cancel();
    }
  }
}
