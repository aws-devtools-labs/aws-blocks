import { runDeployStatusCli, runDeployWaitCli } from '@aws-blocks/blocks/scripts';

// Backs `npm run deploy:status` (read the deploy log once) and
// `npm run deploy:wait` (block until the log reports done/failed). Both read the
// log a backgrounded `npm run deploy > deploy.log 2>&1 &` writes — never
// CloudFormation. The subcommand is argv[2]; default is a one-shot status.
const mode = process.argv[2] === 'wait' ? 'wait' : 'status';

(async () => (mode === 'wait' ? runDeployWaitCli() : runDeployStatusCli()))().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
