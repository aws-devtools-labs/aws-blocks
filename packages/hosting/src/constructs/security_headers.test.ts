import { describe, it } from 'node:test';
import assert from 'node:assert';
import { App, Stack } from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  createCustomHeadersPolicy,
  createSecurityHeadersPolicy,
} from './security_headers.js';

// ---- Test helpers ----

const createStack = (): Stack => {
  const app = new App();
  return new Stack(app, 'TestStack');
};

// ================================================================
// createSecurityHeadersPolicy — isolated unit tests
// ================================================================

void describe('createSecurityHeadersPolicy', () => {
  // ---- Default CSP ----

  void describe('default Content-Security-Policy', () => {
    void it('includes unsafe-inline for script-src and style-src', () => {
      const stack = createStack();
      createSecurityHeadersPolicy(stack, 'Headers');
      const template = Template.fromStack(stack);

      template.hasResourceProperties(
        'AWS::CloudFront::ResponseHeadersPolicy',
        Match.objectLike({
          ResponseHeadersPolicyConfig: Match.objectLike({
            SecurityHeadersConfig: Match.objectLike({
              ContentSecurityPolicy: Match.objectLike({
                ContentSecurityPolicy:
                  Match.stringLikeRegexp("'unsafe-inline'"),
              }),
            }),
          }),
        }),
      );
    });

    void it('includes wss: in connect-src', () => {
      const stack = createStack();
      createSecurityHeadersPolicy(stack, 'Headers');
      const template = Template.fromStack(stack);

      template.hasResourceProperties(
        'AWS::CloudFront::ResponseHeadersPolicy',
        Match.objectLike({
          ResponseHeadersPolicyConfig: Match.objectLike({
            SecurityHeadersConfig: Match.objectLike({
              ContentSecurityPolicy: Match.objectLike({
                ContentSecurityPolicy: Match.stringLikeRegexp('wss:'),
              }),
            }),
          }),
        }),
      );
    });

    void it('does not include unsafe-eval', () => {
      const stack = createStack();
      createSecurityHeadersPolicy(stack, 'Headers');
      const template = Template.fromStack(stack);

      const policies = template.findResources(
        'AWS::CloudFront::ResponseHeadersPolicy',
      );
      const policy = Object.values(policies)[0] as Record<
        string,
        Record<string, unknown>
      >;
      const config = policy.Properties.ResponseHeadersPolicyConfig as Record<
        string,
        unknown
      >;
      const secHeaders = config.SecurityHeadersConfig as Record<
        string,
        unknown
      >;
      const csp = secHeaders.ContentSecurityPolicy as Record<string, string>;
      assert.ok(
        !csp.ContentSecurityPolicy.includes('unsafe-eval'),
        'CSP should NOT include unsafe-eval',
      );
    });

    void it('default CSP does NOT contain unsafe-eval or unsafe-inline', () => {
      const stack = createStack();
      createSecurityHeadersPolicy(stack, 'Headers');
      const template = Template.fromStack(stack);

      const policies = template.findResources(
        'AWS::CloudFront::ResponseHeadersPolicy',
      );
      assert.ok(
        Object.keys(policies).length > 0,
        'Should have a ResponseHeadersPolicy',
      );

      const policy = Object.values(policies)[0] as Record<
        string,
        Record<string, unknown>
      >;
      const config = policy.Properties.ResponseHeadersPolicyConfig as Record<
        string,
        unknown
      >;
      const secHeaders = config.SecurityHeadersConfig as Record<
        string,
        unknown
      >;
      const csp = secHeaders.ContentSecurityPolicy as Record<string, string>;

      assert.ok(
        !csp.ContentSecurityPolicy.includes('unsafe-eval'),
        'Default CSP must NOT contain unsafe-eval',
      );
      // Note: unsafe-inline IS allowed for script-src and style-src in the default policy
      // This test explicitly verifies that unsafe-eval is NOT present
    });

    void it('leaves CSP override:false on the default policy so origin nonces win', () => {
      // SSR frameworks (Next.js Server Components, Remix) emit per-request
      // CSP nonces from origin. Forcing the L3 default to override would
      // strip those nonces and break inline scripts. The default CSP is
      // emitted with override:false; origin CSP wins when present.
      const stack = createStack();
      createSecurityHeadersPolicy(stack, 'Headers');
      const template = Template.fromStack(stack);

      template.hasResourceProperties(
        'AWS::CloudFront::ResponseHeadersPolicy',
        Match.objectLike({
          ResponseHeadersPolicyConfig: Match.objectLike({
            SecurityHeadersConfig: Match.objectLike({
              ContentSecurityPolicy: Match.objectLike({
                Override: false,
              }),
            }),
          }),
        }),
      );
    });

    void it('sets CSP override:true when user supplies contentSecurityPolicy prop', () => {
      const stack = createStack();
      createSecurityHeadersPolicy(stack, 'Headers', {
        contentSecurityPolicy: "default-src 'self'",
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties(
        'AWS::CloudFront::ResponseHeadersPolicy',
        Match.objectLike({
          ResponseHeadersPolicyConfig: Match.objectLike({
            SecurityHeadersConfig: Match.objectLike({
              ContentSecurityPolicy: Match.objectLike({
                Override: true,
              }),
            }),
          }),
        }),
      );
    });
  });

  // ---- Custom CSP ----

  void describe('custom Content-Security-Policy', () => {
    void it('uses custom CSP when provided', () => {
      const stack = createStack();
      const customCsp = "default-src 'none'; script-src 'self'";
      createSecurityHeadersPolicy(stack, 'Headers', {
        contentSecurityPolicy: customCsp,
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties(
        'AWS::CloudFront::ResponseHeadersPolicy',
        Match.objectLike({
          ResponseHeadersPolicyConfig: Match.objectLike({
            SecurityHeadersConfig: Match.objectLike({
              ContentSecurityPolicy: Match.objectLike({
                ContentSecurityPolicy: customCsp,
              }),
            }),
          }),
        }),
      );
    });

    void it('passes through custom CSP with wss: for WebSocket', () => {
      const stack = createStack();
      const wssCsp =
        // eslint-disable-next-line spellcheck/spell-checker
        "default-src 'self'; connect-src 'self' https: wss://realtime.example.com";
      createSecurityHeadersPolicy(stack, 'Headers', {
        contentSecurityPolicy: wssCsp,
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties(
        'AWS::CloudFront::ResponseHeadersPolicy',
        Match.objectLike({
          ResponseHeadersPolicyConfig: Match.objectLike({
            SecurityHeadersConfig: Match.objectLike({
              ContentSecurityPolicy: Match.objectLike({
                ContentSecurityPolicy: wssCsp,
              }),
            }),
          }),
        }),
      );
    });
  });

  // ---- CSP is a ResponseHeadersPolicy resource ----

  void describe('CSP delivery mechanism', () => {
    void it('delivers CSP via ResponseHeadersPolicy (not a custom header)', () => {
      const stack = createStack();
      createSecurityHeadersPolicy(stack, 'Headers');
      const template = Template.fromStack(stack);

      // CSP must be in SecurityHeadersConfig, NOT in CustomHeadersConfig
      template.hasResourceProperties(
        'AWS::CloudFront::ResponseHeadersPolicy',
        Match.objectLike({
          ResponseHeadersPolicyConfig: Match.objectLike({
            SecurityHeadersConfig: Match.objectLike({
              ContentSecurityPolicy: Match.objectLike({
                ContentSecurityPolicy: Match.anyValue(),
              }),
            }),
          }),
        }),
      );

      // Verify no CustomHeadersConfig with CSP
      const policies = template.findResources(
        'AWS::CloudFront::ResponseHeadersPolicy',
      );
      const policy = Object.values(policies)[0] as Record<
        string,
        Record<string, unknown>
      >;
      const config = policy.Properties.ResponseHeadersPolicyConfig as Record<
        string,
        unknown
      >;
      const customHeaders = config.CustomHeadersConfig as
        | Record<string, unknown[]>
        | undefined;

      if (customHeaders?.Items) {
        const cspInCustom =
          // eslint-disable-next-line @typescript-eslint/naming-convention
          (customHeaders.Items as Array<{ Header: string }>).some(
            (item) => item.Header === 'Content-Security-Policy',
          );
        assert.ok(
          !cspInCustom,
          'CSP should NOT be in CustomHeadersConfig — it should be in SecurityHeadersConfig',
        );
      }
    });
  });

  // ---- HSTS ----

  void describe('HSTS', () => {
    void it('sets Strict-Transport-Security with override true', () => {
      const stack = createStack();
      createSecurityHeadersPolicy(stack, 'Headers');
      const template = Template.fromStack(stack);

      template.hasResourceProperties(
        'AWS::CloudFront::ResponseHeadersPolicy',
        Match.objectLike({
          ResponseHeadersPolicyConfig: Match.objectLike({
            SecurityHeadersConfig: Match.objectLike({
              StrictTransportSecurity: Match.objectLike({
                AccessControlMaxAgeSec: Match.anyValue(),
                IncludeSubdomains: true,
                Preload: true,
                Override: true,
              }),
            }),
          }),
        }),
      );
    });
  });

  // ---- X-Content-Type-Options ----

  void describe('X-Content-Type-Options', () => {
    void it('sets contentTypeOptions with override true', () => {
      const stack = createStack();
      createSecurityHeadersPolicy(stack, 'Headers');
      const template = Template.fromStack(stack);

      template.hasResourceProperties(
        'AWS::CloudFront::ResponseHeadersPolicy',
        Match.objectLike({
          ResponseHeadersPolicyConfig: Match.objectLike({
            SecurityHeadersConfig: Match.objectLike({
              ContentTypeOptions: Match.objectLike({
                Override: true,
              }),
            }),
          }),
        }),
      );
    });
  });

  // ---- X-Frame-Options ----

  void describe('X-Frame-Options', () => {
    void it('sets SAMEORIGIN with override true', () => {
      const stack = createStack();
      createSecurityHeadersPolicy(stack, 'Headers');
      const template = Template.fromStack(stack);

      template.hasResourceProperties(
        'AWS::CloudFront::ResponseHeadersPolicy',
        Match.objectLike({
          ResponseHeadersPolicyConfig: Match.objectLike({
            SecurityHeadersConfig: Match.objectLike({
              FrameOptions: Match.objectLike({
                FrameOption: 'SAMEORIGIN',
                Override: true,
              }),
            }),
          }),
        }),
      );
    });
  });

  // ---- XSS Protection ----

  void describe('XSS Protection', () => {
    void it('enables XSS protection with mode block', () => {
      const stack = createStack();
      createSecurityHeadersPolicy(stack, 'Headers');
      const template = Template.fromStack(stack);

      template.hasResourceProperties(
        'AWS::CloudFront::ResponseHeadersPolicy',
        Match.objectLike({
          ResponseHeadersPolicyConfig: Match.objectLike({
            SecurityHeadersConfig: Match.objectLike({
              XSSProtection: Match.objectLike({
                Protection: true,
                ModeBlock: true,
                Override: true,
              }),
            }),
          }),
        }),
      );
    });
  });

  // ---- Referrer Policy ----

  void describe('Referrer Policy', () => {
    void it('sets strict-origin-when-cross-origin', () => {
      const stack = createStack();
      createSecurityHeadersPolicy(stack, 'Headers');
      const template = Template.fromStack(stack);

      template.hasResourceProperties(
        'AWS::CloudFront::ResponseHeadersPolicy',
        Match.objectLike({
          ResponseHeadersPolicyConfig: Match.objectLike({
            SecurityHeadersConfig: Match.objectLike({
              ReferrerPolicy: Match.objectLike({
                ReferrerPolicy: 'strict-origin-when-cross-origin',
                Override: true,
              }),
            }),
          }),
        }),
      );
    });
  });
});

// ================================================================
// createCustomHeadersPolicy — user-override of L3 security headers
// ================================================================

void describe('createCustomHeadersPolicy — user header override', () => {
  // CloudFront rejects security-named headers (x-frame-options, HSTS, etc.)
  // from `customHeadersBehavior.customHeaders[]` with HTTP 400. The L3
  // therefore PARSES the user's value and folds it into the typed
  // `securityHeadersBehavior` slot (Override: true), and FILTERS the
  // header out of the customHeaders array. Non-security custom headers
  // (e.g. cache-control, x-stress-test) still pass through customHeaders.
  void it('folds user x-frame-options into typed FrameOptions slot (and filters it from customHeaders)', () => {
    const stack = createStack();
    createCustomHeadersPolicy(stack, 'CustomHeaders', {
      'x-frame-options': 'DENY',
      'x-stress-test': 'enabled',
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties(
      'AWS::CloudFront::ResponseHeadersPolicy',
      Match.objectLike({
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            FrameOptions: Match.objectLike({
              // Parsed from the user's value, not the L3 default.
              FrameOption: 'DENY',
              Override: true,
            }),
          }),
          // Non-security header still in CustomHeaders.
          CustomHeadersConfig: Match.objectLike({
            Items: Match.arrayWith([
              Match.objectLike({
                Header: 'x-stress-test',
                Value: 'enabled',
                Override: true,
              }),
            ]),
          }),
        }),
      }),
    );

    // Verify x-frame-options was filtered OUT of CustomHeaders.
    const policies = template.findResources(
      'AWS::CloudFront::ResponseHeadersPolicy',
    );
    const policy = Object.values(policies)[0] as Record<
      string,
      Record<string, unknown>
    >;
    const config = policy.Properties.ResponseHeadersPolicyConfig as Record<
      string,
      unknown
    >;
    const customHeaders = config.CustomHeadersConfig as Record<
      string,
      unknown[]
    >;
    const items = (customHeaders.Items ?? []) as Array<Record<string, unknown>>;
    const headerNames = items.map((i) => String(i['Header']).toLowerCase());
    assert.ok(
      !headerNames.includes('x-frame-options'),
      'x-frame-options must be filtered out of CustomHeaders (CloudFront rejects security-named headers there)',
    );
  });

  void it('keeps L3 default SAMEORIGIN on x-frame-options when user does NOT set it', () => {
    const stack = createStack();
    createCustomHeadersPolicy(stack, 'CustomHeaders', {
      'cache-control': 'no-store',
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties(
      'AWS::CloudFront::ResponseHeadersPolicy',
      Match.objectLike({
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            FrameOptions: Match.objectLike({
              FrameOption: 'SAMEORIGIN',
              Override: true,
            }),
          }),
        }),
      }),
    );
  });

  void it('matches case-insensitively on user header names', () => {
    const stack = createStack();
    createCustomHeadersPolicy(stack, 'CustomHeaders', {
      // Capitalized — common in next.config.js headers().
      'X-Frame-Options': 'DENY',
    });
    const template = Template.fromStack(stack);
    // Capitalized name still resolves to the typed slot with the user's value.
    template.hasResourceProperties(
      'AWS::CloudFront::ResponseHeadersPolicy',
      Match.objectLike({
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            FrameOptions: Match.objectLike({
              FrameOption: 'DENY',
              Override: true,
            }),
          }),
        }),
      }),
    );

    // And it's still filtered out of CustomHeaders regardless of case.
    const policies = template.findResources(
      'AWS::CloudFront::ResponseHeadersPolicy',
    );
    const policy = Object.values(policies)[0] as Record<
      string,
      Record<string, unknown>
    >;
    const config = policy.Properties.ResponseHeadersPolicyConfig as Record<
      string,
      unknown
    >;
    const customHeaders = config.CustomHeadersConfig as Record<
      string,
      unknown[]
    >;
    const items = (customHeaders.Items ?? []) as Array<Record<string, unknown>>;
    const headerNames = items.map((i) => String(i['Header']).toLowerCase());
    assert.ok(
      !headerNames.includes('x-frame-options'),
      'X-Frame-Options must be filtered out of CustomHeaders (case-insensitive match)',
    );
  });

  void it('folds user HSTS and referrer-policy into their typed slots; untouched slots keep L3 defaults', () => {
    const stack = createStack();
    createCustomHeadersPolicy(stack, 'CustomHeaders', {
      'strict-transport-security':
        'max-age=63072000; includeSubDomains; preload',
      'referrer-policy': 'no-referrer',
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties(
      'AWS::CloudFront::ResponseHeadersPolicy',
      Match.objectLike({
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            StrictTransportSecurity: Match.objectLike({
              AccessControlMaxAgeSec: 63072000,
              IncludeSubdomains: true,
              Preload: true,
              Override: true,
            }),
            ReferrerPolicy: Match.objectLike({
              ReferrerPolicy: 'no-referrer',
              Override: true,
            }),
            // Untouched slots stay at the L3 defaults with Override: true.
            FrameOptions: Match.objectLike({
              FrameOption: 'SAMEORIGIN',
              Override: true,
            }),
            ContentTypeOptions: Match.objectLike({ Override: true }),
            XSSProtection: Match.objectLike({ Override: true }),
          }),
        }),
      }),
    );
  });
});
