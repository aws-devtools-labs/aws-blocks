import 'package:app_links/app_links.dart';
import 'package:blocks_runtime/blocks_runtime.dart';
import 'package:url_launcher/url_launcher.dart';

/// [BrowserLauncher] that opens the system browser and listens for
/// deep-link callbacks via [AppLinks].
///
/// In the server-relay OIDC flow the IdP's `redirect_uri` is the backend's
/// HTTPS callback, and the backend 302s back to the app via the `relayTo`
/// custom-scheme URI. The launcher captures that relay redirect by matching its
/// scheme (passed as [callbackScheme] — the scheme of `relayTo`). On iOS this
/// surfaces as a universal/deep link delivered to `AppLinks`; on Android it is
/// the custom-scheme intent. The same code path handles both the relay flow and
/// the legacy direct custom-scheme flow.
class FlutterBrowserLauncher implements BrowserLauncher {
  final AppLinks _appLinks;

  FlutterBrowserLauncher({AppLinks? appLinks})
    : _appLinks = appLinks ?? AppLinks();

  @override
  Future<Uri> launch(Uri authorizeUrl, {required String callbackScheme}) async {
    await launchUrl(authorizeUrl, mode: LaunchMode.externalApplication);

    // Wait for the relay (or direct) redirect whose scheme matches the
    // registered custom scheme, ignoring any unrelated deep links.
    final uri = await _appLinks.uriLinkStream.firstWhere(
      (uri) => uri.scheme == callbackScheme,
    );

    return uri;
  }
}
