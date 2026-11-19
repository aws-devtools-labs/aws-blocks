// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:flutter/widgets.dart';
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
/// A launch ends with [OidcCancelledException] instead of a redirect when:
///
/// - the app comes back to the foreground without a redirect, because the user
///   closed the browser or switched back to the app. The browser runs as a
///   separate app, and neither `url_launcher` nor `app_links` reports when it
///   is dismissed, so the launcher watches the app's lifecycle instead: once
///   the app was hidden or paused and is resumed again, it waits
///   [resumeGracePeriod] for the redirect, which the operating system delivers
///   as the app resumes, and then gives up;
/// - [timeout] passes, when one is set;
/// - the `cancel` future passed to `signIn` or `signInDirect` completes.
///
/// It throws a [StateError] when no browser could be opened.
class FlutterBrowserLauncher implements BrowserLauncher {
  FlutterBrowserLauncher({
    AppLinks? appLinks,
    this.timeout,
    this.resumeGracePeriod = const Duration(seconds: 2),
  }) : _appLinks = appLinks ?? AppLinks();

  final AppLinks _appLinks;

  /// How long a launch waits for the redirect, from the moment the browser
  /// is opened, before it throws [OidcCancelledException]. Null, the default,
  /// waits until the user returns to the app or the caller cancels.
  final Duration? timeout;

  /// How long a launch waits for the redirect after the app returns to the
  /// foreground before it throws [OidcCancelledException]. Null turns the
  /// lifecycle check off, for an app that expects the user to switch back to
  /// it while signing in.
  final Duration? resumeGracePeriod;

  @override
  Future<Uri> launch(
    Uri authorizeUrl, {
    required String callbackScheme,
    Future<void>? cancel,
  }) async {
    final redirect = Completer<Uri>();
    // An error can arrive while the browser is still being opened, before
    // anything awaits the redirect.
    redirect.future.ignore();
    var finished = false;
    void end(Object error) {
      if (!finished && !redirect.isCompleted) redirect.completeError(error);
    }

    // Listen before opening the browser, so a redirect that arrives at once
    // isn't missed. Unrelated deep links are ignored.
    final links = _appLinks.uriLinkStream.listen((uri) {
      if (uri.scheme == callbackScheme && !redirect.isCompleted) {
        redirect.complete(uri);
      }
    }, onError: end);

    Timer? resumeTimer;
    var left = false;
    final grace = resumeGracePeriod;
    final lifecycle = grace == null
        ? null
        : AppLifecycleListener(
            onStateChange: (state) {
              switch (state) {
                case AppLifecycleState.hidden || AppLifecycleState.paused:
                  left = true;
                  resumeTimer?.cancel();
                  resumeTimer = null;
                case AppLifecycleState.resumed when left:
                  resumeTimer ??= Timer(
                    grace,
                    () => end(
                      OidcCancelledException(
                        'Sign-in cancelled: the app returned to the '
                        'foreground without a redirect',
                      ),
                    ),
                  );
                default:
              }
            },
          );

    unawaited(
      cancel?.then(
        (_) => end(OidcCancelledException()),
        onError: (Object _) => end(OidcCancelledException()),
      ),
    );

    final limit = timeout;
    Timer? deadline;
    try {
      // A `cancel` that has already completed only runs its callback after
      // this point, so let it run, and don't open the browser for a launch
      // that is already cancelled.
      if (cancel != null) await Future<void>.delayed(Duration.zero);
      if (redirect.isCompleted) return await redirect.future;
      if (!await launchUrl(
        authorizeUrl,
        mode: LaunchMode.externalApplication,
      )) {
        throw StateError('Could not open a browser to sign in');
      }
      if (limit != null) {
        deadline = Timer(
          limit,
          () => end(
            OidcCancelledException(
              'Sign-in timed out after ${limit.inSeconds}s waiting for a '
              'redirect',
            ),
          ),
        );
      }
      return await redirect.future;
    } finally {
      finished = true;
      deadline?.cancel();
      resumeTimer?.cancel();
      lifecycle?.dispose();
      await links.cancel();
    }
  }
}
