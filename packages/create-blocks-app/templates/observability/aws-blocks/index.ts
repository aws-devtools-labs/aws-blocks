import { ApiNamespace, Dashboard, Logger, Metrics, Scope, Tracer } from '@aws-blocks/blocks';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Scope below to see the docstring with complete Building Block index

const scope = new Scope('my-app');

// Logger: structured JSON logs. Each call writes one JSON line (`error` to
// stderr, the rest to stdout); deployed, CloudWatch Logs captures it.
const log = new Logger(scope, 'orders-log');

// Metrics: CloudWatch metrics written as EMF (Embedded Metric Format) JSON to
// stdout, locally and deployed. CloudWatch extracts the metric from the log line.
const metrics = new Metrics(scope, 'metrics', { namespace: 'MyApp' });

// Tracer: wrap work in segments. Deployed it records X-Ray segments; locally it
// keeps the last 100 traces in .bb-data/ and prints each one to stdout.
const tracer = new Tracer(scope, 'tracer');

// Dashboard: a CloudWatch Dashboard with health, logs, traces and the metrics
// below. Cloud-only: under `npm run dev`, GET /aws-blocks/dashboard answers 503
// with pointers to the local logs, metrics and traces; deployed, it redirects
// to the dashboard.
new Dashboard(scope, 'dashboard', {
  title: 'My App',
  metrics: { metrics, metricConfigs: [{ name: 'OrdersPlaced' }] },
});

// Every method below is a public RPC endpoint — no auth by default.
// To gate one, add an auth block (e.g. @aws-blocks/bb-auth-cognito) and call
// it first — see its README:
//   const user = await auth.requireAuth(context);
export const api = new ApiNamespace(scope, 'api', () => ({
  // Places an order, and records it three ways: a log line, an `OrdersPlaced`
  // metric and a `placeOrder` trace segment. The returned `traceId` identifies
  // the trace (null when tracing is off or the request is not sampled).
  // Deployed, the Logger adds the X-Ray `traceId` to every log line itself;
  // `traceId` is a reserved log field, so passing it in the context is ignored.
  async placeOrder(item: string) {
    return await tracer.startSegment('placeOrder', async (segment) => {
      const orderId = crypto.randomUUID();
      const traceId = tracer.getTraceId();
      segment.addAnnotation('item', item);
      log.info('Order placed', { orderId, item });
      metrics.emit('OrdersPlaced', 1, { unit: 'Count' });
      return { orderId, traceId };
    });
  },
}));
