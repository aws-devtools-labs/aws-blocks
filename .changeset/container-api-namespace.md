---
'@aws-blocks/core': minor
'@aws-blocks/bb-container-compute': minor
'@aws-blocks/bb-compute': patch
'@aws-blocks/blocks': minor
---

An API namespace can run on a `container` compute:

```ts
const renderCompute = new Compute(scope, 'render', { type: 'container', size: { vcpu: 2, memory: 4096 } });
export const render = new ApiNamespace(scope, 'render', (context) => ({ … }), { compute: renderCompute });
```

The container's tasks serve the namespace with the same dispatch as the Lambda handler (CORS, cookies, error envelopes), so clients call it exactly as before at `/aws-blocks/api/render`.

- The shared API gateway reaches the tasks through a VPC link to an internal Application Load Balancer that the compute provisions in the app's VPC: one load balancer and one listener per backend, with a path rule per namespace forwarding to its container's target group, health-checked on the task's readiness port. A container that only runs jobs gets no target group.
- The tasks admit the load balancer on a security group of their own; the shared compute security group stays closed to inbound traffic.
- API calls to a container keep the gateway's ~29-second cap. A stopping task finishes its in-flight requests (up to 65 s) before it shuts down.
- A container that serves API namespaces needs a running task: `scaling.minInstances: 0` fails synth. Without a `scaling.strategy`, one that also runs an `AsyncJob` scales on CPU, and its queue backlog adds tasks too.
- Moving a namespace that already serves traffic onto a container: during that deploy, its calls can get 503s for the minute or two the new tasks take to start.
- `runContainer()` takes the backend module (`runContainer({ backend })`) and serves its API on port 8080, with readiness on port 8081; called without it, the container answers a health check on port 8080 as before. A container compute passes it only when the compute serves API traffic.
- The container compute's dashboard section gains API request, 5xx, latency and task-health widgets.
