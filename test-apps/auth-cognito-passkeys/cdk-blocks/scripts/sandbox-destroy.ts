import { destroySandbox } from 'aws-cdk-blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

destroySandbox(join(__dirname, '..', 'index.cdk.ts'));
