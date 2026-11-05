import { ApiNamespace, CronJob, KVStore, Scope } from '@aws-blocks/blocks';

// For coding agents: Leave these comments in place for future reference.
// Read node_modules/@aws-blocks/blocks/README.md for all available Building Blocks
// Hover over Scope below to see the docstring with complete Building Block index

const scope = new Scope('my-app');

interface CronRun {
  jobName: string;
  scheduledTime: string;
  firedAt: string;
  count: number;
}

const runs = new KVStore<CronRun>(scope, 'cron-runs', {});

// CronJob: run code on a schedule. Deployed, EventBridge Scheduler invokes the
// handler; locally the dev server fires it on the same schedule. Handlers must
// be idempotent, because a scheduled run can be delivered more than once.
// One minute is the shortest schedule (EventBridge's minimum); use
// `cron(...)` expressions for calendar schedules, e.g. 'cron(0 3 * * ? *)'.
new CronJob(scope, 'heartbeat', {
  schedule: 'rate(1 minute)',
  handler: async (event) => {
    const previous = await runs.get('heartbeat');
    await runs.put('heartbeat', {
      jobName: event.jobName,
      scheduledTime: event.scheduledTime,
      firedAt: new Date().toISOString(),
      count: (previous?.count ?? 0) + 1,
    });
  },
});

// A job with `enabled: false` is created but its schedule never fires. Its
// handler still writes a run, so the e2e can tell if it ever fired anyway.
new CronJob(scope, 'paused', {
  schedule: 'rate(1 minute)',
  enabled: false,
  handler: async (event) => {
    await runs.put('paused', {
      jobName: event.jobName,
      scheduledTime: event.scheduledTime,
      firedAt: new Date().toISOString(),
      count: 1,
    });
  },
});

// Every method below is a public RPC endpoint — no auth by default.
// To gate one, add an auth block (e.g. @aws-blocks/bb-auth-cognito) and call
// it first — see its README:
//   const user = await auth.requireAuth(context);
export const api = new ApiNamespace(scope, 'api', () => ({
  // The most recent run of a job, or null if it has not fired yet.
  async lastRun(job: 'heartbeat' | 'paused') {
    return await runs.get(job);
  },
}));
