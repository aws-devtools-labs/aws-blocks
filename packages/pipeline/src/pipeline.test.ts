// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { _setSynthSecretFetcher } from '@aws-blocks/hosting';
import * as cdk from 'aws-cdk-lib';
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { CodePipelineSource } from 'aws-cdk-lib/pipelines';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { secret } from './index.js';
import { Pipeline, validateAppFilePath } from './pipeline-construct.js';
import type { PipelineProps, PipelineStageConfig } from './types.js';

// ================================================================
// Pipeline construct tests
//
// Validate that the Pipeline L3 construct produces the expected
// CloudFormation resources for a multi-branch CDK Pipelines setup.
// ================================================================

const MOCK_CONNECTION_ARN = 'arn:aws:codeconnections:us-east-1:123456789012:connection/test-connection-id';
const MOCK_REPO = 'my-org/my-app';

function minimalStageFactory(scope: cdk.Stage, stageConfig: PipelineStageConfig): void {
	new Stack(scope, 'AppStack', { env: stageConfig.env });
}

function defaultPipelineProps(overrides?: Partial<PipelineProps>): PipelineProps {
	return {
		source: {
			repo: MOCK_REPO,
			connectionArn: MOCK_CONNECTION_ARN,
		},
		branches: [
			{
				branch: 'main',
				stages: [{ name: 'beta' }, { name: 'prod', requireApproval: true }],
			},
		],
		stageFactory: minimalStageFactory,
		...overrides,
	};
}

describe('Pipeline', () => {
	describe('basic pipeline creation', () => {
		it('creates a CodePipeline V2 resource', () => {
			const app = new App();
			const stack = new Stack(app, 'PipelineStack');

			new Pipeline(stack, 'TestPipeline', defaultPipelineProps());

			const template = Template.fromStack(stack);

			template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
				PipelineType: 'V2',
			});
		});

		it('uses CodeConnections as the source with correct repo and branch', () => {
			const app = new App();
			const stack = new Stack(app, 'SourceStack');

			new Pipeline(stack, 'TestPipeline', defaultPipelineProps());

			const template = Template.fromStack(stack);

			template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
				Stages: Match.arrayWith([
					Match.objectLike({
						Name: 'Source',
						Actions: Match.arrayWith([
							Match.objectLike({
								ActionTypeId: Match.objectLike({
									Provider: 'CodeStarSourceConnection',
								}),
								Configuration: Match.objectLike({
									FullRepositoryId: MOCK_REPO,
									BranchName: 'main',
									ConnectionArn: MOCK_CONNECTION_ARN,
								}),
							}),
						]),
					}),
				]),
			});
		});

		it('creates a Build (synth) stage', () => {
			const app = new App();
			const stack = new Stack(app, 'SynthStack');

			new Pipeline(stack, 'TestPipeline', defaultPipelineProps());

			const template = Template.fromStack(stack);

			template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
				Stages: Match.arrayWith([
					Match.objectLike({
						Name: 'Build',
					}),
				]),
			});
		});

		it('exposes codePipelines map keyed by branch name', () => {
			const app = new App();
			const stack = new Stack(app, 'ExposeStack');

			const pipeline = new Pipeline(stack, 'TestPipeline', defaultPipelineProps());

			assert.ok(pipeline.codePipelines, 'Should expose codePipelines property');
			assert.ok(pipeline.codePipelines.get('main'), 'Should have pipeline for main branch');
		});
	});

	describe('input validation', () => {
		it('throws on empty branches array', () => {
			const app = new App();
			const stack = new Stack(app, 'EmptyBranchStack');

			assert.throws(
				() => new Pipeline(stack, 'TestPipeline', defaultPipelineProps({ branches: [] })),
				/must not be empty/,
			);
		});

		it('throws on empty stages in a branch', () => {
			const app = new App();
			const stack = new Stack(app, 'EmptyStagesStack');

			assert.throws(
				() =>
					new Pipeline(
						stack,
						'TestPipeline',
						defaultPipelineProps({
							branches: [{ branch: 'main', stages: [] }],
						}),
					),
				/empty.*stages/i,
			);
		});

		it('throws on duplicate branch names', () => {
			const app = new App();
			const stack = new Stack(app, 'DupBranchStack');

			assert.throws(
				() =>
					new Pipeline(
						stack,
						'TestPipeline',
						defaultPipelineProps({
							branches: [
								{ branch: 'main', stages: [{ name: 'beta' }] },
								{ branch: 'main', stages: [{ name: 'prod' }] },
							],
						}),
					),
				/duplicate branch name.*main/i,
			);
		});

		it('throws on duplicate stage names within a branch', () => {
			const app = new App();
			const stack = new Stack(app, 'DupStageStack');

			assert.throws(
				() =>
					new Pipeline(
						stack,
						'TestPipeline',
						defaultPipelineProps({
							branches: [{ branch: 'main', stages: [{ name: 'beta' }, { name: 'beta' }] }],
						}),
					),
				/duplicate stage name.*beta/i,
			);
		});

		it('throws on malformed connectionArn (not an ARN)', () => {
			const app = new App();
			const stack = new Stack(app, 'BadArnStack');

			assert.throws(
				() =>
					new Pipeline(
						stack,
						'TestPipeline',
						defaultPipelineProps({
							source: {
								repo: MOCK_REPO,
								connectionArn: 'not-a-valid-arn',
							},
						}),
					),
				/connectionArn.*arn:aws:/,
			);
		});

		it('throws on invalid repo format (missing /)', () => {
			const app = new App();
			const stack = new Stack(app, 'BadRepoStack');

			assert.throws(
				() =>
					new Pipeline(
						stack,
						'TestPipeline',
						defaultPipelineProps({
							source: {
								repo: 'my-app-no-owner',
								connectionArn: MOCK_CONNECTION_ARN,
							},
						}),
					),
				/owner\/repo/,
			);
		});

		it('throws when cross-account stages used without crossAccountKeys', () => {
			const app = new App();
			const stack = new Stack(app, 'CrossAccountStack', {
				env: { account: '111111111111', region: 'us-east-1' },
			});

			assert.throws(
				() =>
					new Pipeline(
						stack,
						'TestPipeline',
						defaultPipelineProps({
							crossAccountKeys: false,
							branches: [
								{
									branch: 'main',
									stages: [
										{
											name: 'prod',
											env: { account: '222222222222', region: 'us-east-1' },
										},
									],
								},
							],
						}),
					),
				/crossAccountKeys must be true/,
			);
		});

		it('does not throw when cross-account stages have crossAccountKeys enabled', () => {
			const app = new App();
			const stack = new Stack(app, 'CrossAccountOkStack', {
				env: { account: '111111111111', region: 'us-east-1' },
			});

			assert.doesNotThrow(
				() =>
					new Pipeline(
						stack,
						'TestPipeline',
						defaultPipelineProps({
							crossAccountKeys: true,
							branches: [
								{
									branch: 'main',
									stages: [
										{
											name: 'prod',
											env: { account: '222222222222', region: 'us-east-1' },
										},
									],
								},
							],
						}),
					),
			);
		});

		it('throws when bakeTime is zero or negative', () => {
			const app = new App();
			const stack = new Stack(app, 'BakeTimeLimitStack');

			assert.throws(
				() =>
					new Pipeline(
						stack,
						'TestPipeline',
						defaultPipelineProps({
							branches: [
								{
									branch: 'main',
									stages: [{ name: 'beta', bakeTime: Duration.minutes(0) }],
								},
							],
						}),
					),
				/bakeTime.*must be positive/,
			);
		});

		it('does not throw when bakeTime is large (e.g., 120 minutes)', () => {
			const app = new App();
			const stack = new Stack(app, 'BakeTimeLargeStack');

			assert.doesNotThrow(
				() =>
					new Pipeline(
						stack,
						'TestPipeline',
						defaultPipelineProps({
							branches: [
								{
									branch: 'main',
									stages: [{ name: 'beta', bakeTime: Duration.minutes(120) }],
								},
							],
						}),
					),
			);
		});

		it('throws when sync constructor receives App scope instead of Stack', () => {
			const app = new App();

			assert.throws(
				() =>
					new Pipeline(app as any, 'TestPipeline', {
						source: {
							repo: 'org/app',
							connectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/test-id',
						},
						branches: [{ branch: 'main', stages: [{ name: 'prod' }] }],
						stageFactory: (scope) => {
							new cdk.Stack(scope, 'AppStack');
						},
					}),
				/Stack scope.*not an App|sync constructor requires a Stack/,
			);
		});
	});

	describe('branch name sanitization', () => {
		it('sanitizes branch names with slashes for construct IDs', () => {
			const app = new App();
			const stack = new Stack(app, 'SlashBranchStack');

			const pipeline = new Pipeline(
				stack,
				'TestPipeline',
				defaultPipelineProps({
					branches: [
						{
							branch: 'feature/my-feature',
							stages: [{ name: 'alpha' }],
						},
					],
				}),
			);

			assert.ok(pipeline.codePipelines.get('feature/my-feature'), 'Should be keyed by original branch name');

			// Should not throw — proving the construct ID was sanitized
			Template.fromStack(stack);
		});

		it('sanitizes branch names with special characters', () => {
			const app = new App();
			const stack = new Stack(app, 'SpecialCharBranchStack');

			assert.doesNotThrow(() => {
				new Pipeline(
					stack,
					'TestPipeline',
					defaultPipelineProps({
						branches: [
							{
								branch: 'release/v1.0@beta',
								stages: [{ name: 'beta' }],
							},
						],
					}),
				);
			});
		});
	});

	describe('multi-branch support', () => {
		it('creates separate pipelines for each branch', () => {
			const app = new App();
			const stack = new Stack(app, 'MultiBranchStack');

			new Pipeline(
				stack,
				'TestPipeline',
				defaultPipelineProps({
					branches: [
						{
							branch: 'main',
							stages: [{ name: 'beta' }, { name: 'prod', requireApproval: true }],
						},
						{
							branch: 'develop',
							stages: [{ name: 'alpha' }],
						},
					],
				}),
			);

			const template = Template.fromStack(stack);

			// Should have 2 CodePipeline resources
			template.resourceCountIs('AWS::CodePipeline::Pipeline', 2);
		});

		it('each branch pipeline uses the correct branch name as source', () => {
			const app = new App();
			const stack = new Stack(app, 'BranchSourceStack');

			new Pipeline(
				stack,
				'TestPipeline',
				defaultPipelineProps({
					branches: [
						{
							branch: 'main',
							stages: [{ name: 'prod' }],
						},
						{
							branch: 'develop',
							stages: [{ name: 'alpha' }],
						},
					],
				}),
			);

			const template = Template.fromStack(stack);
			const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
			const pipelineKeys = Object.keys(pipelines);

			assert.strictEqual(pipelineKeys.length, 2, 'Should have 2 pipelines');

			// Collect branch names from all pipelines
			const branchNames = pipelineKeys.map((key) => {
				const stages = (pipelines[key] as any).Properties.Stages as any[];
				const sourceStage = stages.find((s: any) => s.Name === 'Source');
				return sourceStage?.Actions?.[0]?.Configuration?.BranchName;
			});

			assert.ok(branchNames.includes('main'), 'Should have pipeline for main branch');
			assert.ok(branchNames.includes('develop'), 'Should have pipeline for develop branch');
		});
	});

	describe('stage features', () => {
		it('adds manual approval step when requireApproval is true', () => {
			const app = new App();
			const stack = new Stack(app, 'ApprovalStack');

			new Pipeline(
				stack,
				'TestPipeline',
				defaultPipelineProps({
					branches: [
						{
							branch: 'main',
							stages: [
								{ name: 'beta' },
								{ name: 'prod', requireApproval: true, approvalComment: 'Ready for prod?' },
							],
						},
					],
				}),
			);

			const template = Template.fromStack(stack);

			template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
				Stages: Match.arrayWith([
					Match.objectLike({
						Actions: Match.arrayWith([
							Match.objectLike({
								ActionTypeId: Match.objectLike({
									Category: 'Approval',
									Provider: 'Manual',
								}),
							}),
						]),
					}),
				]),
			});
		});

		it('does not add approval step when requireApproval is false or omitted', () => {
			const app = new App();
			const stack = new Stack(app, 'NoApprovalStack');

			new Pipeline(
				stack,
				'TestPipeline',
				defaultPipelineProps({
					branches: [
						{
							branch: 'main',
							stages: [{ name: 'beta' }],
						},
					],
				}),
			);

			const template = Template.fromStack(stack);
			const pipelineResources = template.findResources('AWS::CodePipeline::Pipeline');
			const pipelineKey = Object.keys(pipelineResources)[0];
			const stages = (pipelineResources[pipelineKey] as any).Properties.Stages as any[];

			const betaStage = stages.find((s: any) => s.Name.includes('beta'));
			assert.ok(betaStage, 'Should have beta stage');

			const approvalActions = betaStage.Actions.filter((a: any) => a.ActionTypeId?.Category === 'Approval');
			assert.strictEqual(approvalActions.length, 0, 'Beta should NOT have approval actions');
		});

		it('manual approval works per branch independently', () => {
			const app = new App();
			const stack = new Stack(app, 'IndependentApprovalStack');

			new Pipeline(
				stack,
				'TestPipeline',
				defaultPipelineProps({
					branches: [
						{
							branch: 'main',
							stages: [{ name: 'prod', requireApproval: true }],
						},
						{
							branch: 'develop',
							stages: [{ name: 'alpha' }],
						},
					],
				}),
			);

			const template = Template.fromStack(stack);
			const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
			const pipelineKeys = Object.keys(pipelines);

			assert.strictEqual(pipelineKeys.length, 2);

			for (const key of pipelineKeys) {
				const stages = (pipelines[key] as any).Properties.Stages as any[];
				const sourceStage = stages.find((s: any) => s.Name === 'Source');
				const branchName = sourceStage?.Actions?.[0]?.Configuration?.BranchName;

				if (branchName === 'main') {
					const deployStages = stages.filter(
						(s: any) => s.Name !== 'Source' && s.Name !== 'Build' && s.Name !== 'UpdatePipeline',
					);
					const hasApproval = deployStages.some((s: any) =>
						s.Actions.some((a: any) => a.ActionTypeId?.Category === 'Approval'),
					);
					assert.ok(hasApproval, 'main branch should have approval');
				} else if (branchName === 'develop') {
					const deployStages = stages.filter(
						(s: any) => s.Name !== 'Source' && s.Name !== 'Build' && s.Name !== 'UpdatePipeline',
					);
					const hasApproval = deployStages.some((s: any) =>
						s.Actions.some((a: any) => a.ActionTypeId?.Category === 'Approval'),
					);
					assert.ok(!hasApproval, 'develop branch should NOT have approval');
				}
			}
		});

		it('adds bake time step when bakeTime is specified', () => {
			const app = new App();
			const stack = new Stack(app, 'BakeTimeStack');

			new Pipeline(
				stack,
				'TestPipeline',
				defaultPipelineProps({
					branches: [
						{
							branch: 'main',
							stages: [{ name: 'beta', bakeTime: Duration.minutes(5) }],
						},
					],
				}),
			);

			const template = Template.fromStack(stack);

			template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
				Stages: Match.arrayWith([
					Match.objectLike({
						Actions: Match.arrayWith([
							Match.objectLike({
								ActionTypeId: Match.objectLike({
									Category: 'Build',
									Provider: 'CodeBuild',
								}),
							}),
						]),
					}),
				]),
			});

			const codebuildProjects = template.findResources('AWS::CodeBuild::Project');
			assert.ok(Object.keys(codebuildProjects).length >= 1, 'Should create CodeBuild project for bake step');

			// Verify the sleep command is in the buildspec
			template.hasResourceProperties('AWS::CodeBuild::Project', {
				Source: Match.objectLike({
					BuildSpec: Match.stringLikeRegexp('sleep 300'),
				}),
			});
		});

		it('calls stageFactory for each stage in each branch', () => {
			const app = new App();
			const stack = new Stack(app, 'FactoryStack');

			const calledStages: string[] = [];

			new Pipeline(
				stack,
				'TestPipeline',
				defaultPipelineProps({
					branches: [
						{
							branch: 'main',
							stages: [{ name: 'beta' }, { name: 'prod' }],
						},
						{
							branch: 'develop',
							stages: [{ name: 'alpha' }],
						},
					],
					stageFactory: (scope, stageConfig) => {
						calledStages.push(stageConfig.name);
						new Stack(scope, 'AppStack', { env: stageConfig.env });
					},
				}),
			);

			assert.deepStrictEqual(
				calledStages,
				['beta', 'prod', 'alpha'],
				'stageFactory should be called for each stage in order across branches',
			);
		});

		it('passes env to stageFactory when specified', () => {
			const app = new App();
			const stack = new Stack(app, 'EnvPassStack', {
				env: { account: '111111111111', region: 'us-east-1' },
			});

			const receivedEnvs: Array<cdk.Environment | undefined> = [];

			new Pipeline(
				stack,
				'TestPipeline',
				defaultPipelineProps({
					branches: [
						{
							branch: 'main',
							stages: [
								{ name: 'beta', env: { account: '111111111111', region: 'us-west-2' } },
								{ name: 'prod' },
							],
						},
					],
					stageFactory: (scope, stageConfig) => {
						receivedEnvs.push(stageConfig.env);
						new Stack(scope, 'AppStack', { env: stageConfig.env });
					},
				}),
			);

			assert.deepStrictEqual(receivedEnvs[0], { account: '111111111111', region: 'us-west-2' });
			assert.strictEqual(receivedEnvs[1], undefined);
		});
	});

	describe('per-branch triggerOnPush', () => {
		it('uses branch-level triggerOnPush over source-level', () => {
			const app = new App();
			const stack = new Stack(app, 'BranchTriggerStack');

			new Pipeline(
				stack,
				'TestPipeline',
				defaultPipelineProps({
					source: {
						repo: MOCK_REPO,
						connectionArn: MOCK_CONNECTION_ARN,
						triggerOnPush: true,
					},
					branches: [
						{
							branch: 'main',
							triggerOnPush: false,
							stages: [{ name: 'prod' }],
						},
						{
							branch: 'develop',
							stages: [{ name: 'alpha' }],
						},
					],
				}),
			);

			const template = Template.fromStack(stack);
			const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
			const pipelineKeys = Object.keys(pipelines);

			assert.strictEqual(pipelineKeys.length, 2, 'Should have 2 pipelines');

			// Verify that the main branch pipeline has DetectChanges: false
			template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
				Stages: Match.arrayWith([
					Match.objectLike({
						Actions: Match.arrayWith([
							Match.objectLike({
								Configuration: Match.objectLike({
									DetectChanges: false,
								}),
							}),
						]),
					}),
				]),
			});
		});

		it('defaults to source.triggerOnPush when branch-level is not set', () => {
			const app = new App();
			const stack = new Stack(app, 'DefaultTriggerStack');

			// This should succeed without error (triggerOnPush falls through)
			new Pipeline(
				stack,
				'TestPipeline',
				defaultPipelineProps({
					source: {
						repo: MOCK_REPO,
						connectionArn: MOCK_CONNECTION_ARN,
						triggerOnPush: false,
					},
					branches: [
						{
							branch: 'main',
							stages: [{ name: 'prod' }],
						},
					],
				}),
			);

			Template.fromStack(stack);
		});
	});

	describe('synth configuration', () => {
		it('uses default synth commands when synth config is omitted', () => {
			const app = new App();
			const stack = new Stack(app, 'DefaultSynthStack');

			new Pipeline(stack, 'TestPipeline', defaultPipelineProps());

			const template = Template.fromStack(stack);
			const projects = template.findResources('AWS::CodeBuild::Project');
			assert.ok(Object.keys(projects).length >= 1, 'Should create at least one CodeBuild project for synth');
		});

		it('accepts custom synth commands', () => {
			const app = new App();
			const stack = new Stack(app, 'CustomSynthStack');

			new Pipeline(
				stack,
				'TestPipeline',
				defaultPipelineProps({
					synth: {
						commands: ['pnpm install', 'pnpm build', 'pnpm cdk synth'],
					},
				}),
			);

			const template = Template.fromStack(stack);
			template.resourceCountIs('AWS::CodePipeline::Pipeline', 1);
		});

		it('accepts synth environment variables', () => {
			const app = new App();
			const stack = new Stack(app, 'SynthEnvStack');

			new Pipeline(
				stack,
				'TestPipeline',
				defaultPipelineProps({
					synth: {
						commands: ['npm ci', 'npx cdk synth'],
						env: { NODE_ENV: 'production' },
					},
				}),
			);

			const template = Template.fromStack(stack);

			template.hasResourceProperties('AWS::CodeBuild::Project', {
				Environment: Match.objectLike({
					EnvironmentVariables: Match.arrayWith([
						Match.objectLike({
							Name: 'NODE_ENV',
							Value: 'production',
						}),
					]),
				}),
			});
		});

		it('accepts primaryOutputDirectory for monorepo support', () => {
			const app = new App();
			const stack = new Stack(app, 'MonorepoStack');

			assert.doesNotThrow(() => {
				new Pipeline(
					stack,
					'TestPipeline',
					defaultPipelineProps({
						synth: {
							commands: ['npm ci', 'npx cdk synth'],
							primaryOutputDirectory: 'packages/infra/cdk.out',
						},
					}),
				);
			});

			Template.fromStack(stack);
		});

		it('accepts dockerEnabled for synth step', () => {
			const app = new App();
			const stack = new Stack(app, 'DockerSynthStack');

			assert.doesNotThrow(() => {
				new Pipeline(
					stack,
					'TestPipeline',
					defaultPipelineProps({
						synth: {
							commands: ['npm ci', 'npx cdk synth'],
							dockerEnabled: true,
						},
					}),
				);
			});

			Template.fromStack(stack);
		});

		it('prepends --conditions=cdk to user NODE_OPTIONS', () => {
			const app = new App();
			const stack = new cdk.Stack(app, 'NodeOptionsStack');

			new Pipeline(stack, 'TestPipeline', {
				source: {
					repo: 'org/app',
					connectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/test-id',
				},
				branches: [{ branch: 'main', stages: [{ name: 'prod' }] }],
				stageFactory: (scope) => {
					new cdk.Stack(scope, 'AppStack');
				},
				synth: {
					commands: ['npm ci', 'npx cdk synth'],
					env: { NODE_OPTIONS: '--max-old-space-size=4096' },
				},
			});

			const template = Template.fromStack(stack);
			template.hasResourceProperties('AWS::CodeBuild::Project', {
				Environment: Match.objectLike({
					EnvironmentVariables: Match.arrayWith([
						Match.objectLike({
							Name: 'NODE_OPTIONS',
							Value: '--conditions=cdk --max-old-space-size=4096',
						}),
					]),
				}),
			});
		});
	});

	describe('pipeline options', () => {
		it('enables self-mutation by default', () => {
			const app = new App();
			const stack = new Stack(app, 'SelfMutateStack');

			new Pipeline(stack, 'TestPipeline', defaultPipelineProps());

			const template = Template.fromStack(stack);

			template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
				Stages: Match.arrayWith([
					Match.objectLike({
						Name: 'UpdatePipeline',
					}),
				]),
			});
		});

		it('disables self-mutation when selfMutation is false', () => {
			const app = new App();
			const stack = new Stack(app, 'NoSelfMutateStack');

			new Pipeline(
				stack,
				'TestPipeline',
				defaultPipelineProps({
					selfMutation: false,
				}),
			);

			const template = Template.fromStack(stack);
			const pipelineResources = template.findResources('AWS::CodePipeline::Pipeline');
			const pipelineKey = Object.keys(pipelineResources)[0];
			const stages = (pipelineResources[pipelineKey] as any).Properties.Stages as any[];
			const stageNames = stages.map((s: any) => s.Name);

			assert.ok(
				!stageNames.includes('UpdatePipeline'),
				`Should NOT have UpdatePipeline stage when selfMutation is false, got: ${stageNames.join(', ')}`,
			);
		});
	});

	describe('generic config type', () => {
		interface MyAppConfig {
			domain: string;
			enableCanary: boolean;
		}

		it('accepts a typed config generic', () => {
			const app = new App();
			const stack = new Stack(app, 'GenericStack');

			const receivedConfigs: Array<MyAppConfig | undefined> = [];

			new Pipeline<MyAppConfig>(stack, 'TestPipeline', {
				source: {
					repo: MOCK_REPO,
					connectionArn: MOCK_CONNECTION_ARN,
				},
				branches: [
					{
						branch: 'main',
						stages: [
							{ name: 'beta', config: { domain: 'beta.example.com', enableCanary: false } },
							{ name: 'prod', config: { domain: 'example.com', enableCanary: true } },
						],
					},
				],
				stageFactory: (scope, stageConfig) => {
					receivedConfigs.push(stageConfig.config);
					new Stack(scope, 'AppStack', { env: stageConfig.env });
				},
			});

			assert.deepStrictEqual(receivedConfigs[0], { domain: 'beta.example.com', enableCanary: false });
			assert.deepStrictEqual(receivedConfigs[1], { domain: 'example.com', enableCanary: true });
		});

		it('works without explicit generic (defaults to Record<string, unknown>)', () => {
			const app = new App();
			const stack = new Stack(app, 'NoGenericStack');

			assert.doesNotThrow(() => {
				new Pipeline(
					stack,
					'TestPipeline',
					defaultPipelineProps({
						branches: [
							{
								branch: 'main',
								stages: [{ name: 'beta', config: { anything: 'goes' } }],
							},
						],
					}),
				);
			});
		});
	});
});

describe('Pipeline.create (async stageFactory)', () => {
	it('creates pipeline with async stageFactory', async () => {
		const app = new App();
		const stack = new Stack(app, 'AsyncPipelineStack');

		const calledStages: string[] = [];

		const pipeline = await Pipeline.create(stack, 'TestPipeline', {
			source: {
				repo: MOCK_REPO,
				connectionArn: MOCK_CONNECTION_ARN,
			},
			branches: [
				{
					branch: 'main',
					stages: [{ name: 'beta' }, { name: 'prod', requireApproval: true }],
				},
			],
			stageFactory: async (scope, stageConfig) => {
				// Simulate async work (e.g., BlocksStack.create())
				await new Promise((resolve) => setTimeout(resolve, 1));
				calledStages.push(stageConfig.name);
				new Stack(scope, 'AppStack', { env: stageConfig.env });
			},
		});

		assert.deepStrictEqual(calledStages, ['beta', 'prod']);
		assert.ok(pipeline.codePipelines.has('main'));

		const template = Template.fromStack(stack);
		template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
			PipelineType: 'V2',
		});
	});

	it('supports multi-branch with async factory', async () => {
		const app = new App();
		const stack = new Stack(app, 'AsyncMultiBranchStack');

		const pipeline = await Pipeline.create(stack, 'TestPipeline', {
			source: {
				repo: MOCK_REPO,
				connectionArn: MOCK_CONNECTION_ARN,
			},
			branches: [
				{ branch: 'main', stages: [{ name: 'prod' }] },
				{ branch: 'develop', stages: [{ name: 'alpha' }] },
			],
			stageFactory: async (scope, stageConfig) => {
				await Promise.resolve();
				new Stack(scope, 'AppStack', { env: stageConfig.env });
			},
		});

		assert.ok(pipeline.codePipelines.has('main'));
		assert.ok(pipeline.codePipelines.has('develop'));
		assert.strictEqual(pipeline.codePipelines.size, 2);
	});

	it('validates props before async stage creation', async () => {
		const app = new App();
		const stack = new Stack(app, 'AsyncValidationStack');

		await assert.rejects(
			() =>
				Pipeline.create(stack, 'TestPipeline', {
					source: { repo: 'invalid-repo', connectionArn: MOCK_CONNECTION_ARN },
					branches: [{ branch: 'main', stages: [{ name: 'beta' }] }],
					stageFactory: async () => {},
				}),
			/owner\/repo/,
		);
	});
});

describe('triggerFilters', () => {
	it('adds FilePaths trigger when triggerFilters are specified', () => {
		const app = new App();
		const stack = new Stack(app, 'TriggerFilterStack');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				source: {
					repo: MOCK_REPO,
					connectionArn: MOCK_CONNECTION_ARN,
					triggerFilters: ['packages/backend/**'],
				},
				branches: [
					{
						branch: 'main',
						stages: [{ name: 'beta' }],
					},
				],
			}),
		);

		const template = Template.fromStack(stack);

		template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
			Triggers: Match.arrayWith([
				Match.objectLike({
					GitConfiguration: Match.objectLike({
						Push: Match.arrayWith([
							Match.objectLike({
								FilePaths: Match.objectLike({
									Includes: ['packages/backend/**'],
								}),
							}),
						]),
					}),
					ProviderType: 'CodeStarSourceConnection',
				}),
			]),
		});
	});

	it('does not add triggers when triggerFilters is not specified', () => {
		const app = new App();
		const stack = new Stack(app, 'NoTriggerFilterStack');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				source: {
					repo: MOCK_REPO,
					connectionArn: MOCK_CONNECTION_ARN,
				},
				branches: [
					{
						branch: 'main',
						stages: [{ name: 'beta' }],
					},
				],
			}),
		);

		const template = Template.fromStack(stack);
		const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
		const pipelineKey = Object.keys(pipelines)[0];
		const pipelineProps = (pipelines[pipelineKey] as any).Properties;

		assert.ok(
			!pipelineProps.Triggers || pipelineProps.Triggers.length === 0,
			'Should not have Triggers when triggerFilters is not set',
		);
	});
});

describe('ARN validation', () => {
	it('accepts GovCloud ARN format (arn:aws-us-gov:codeconnections:...)', () => {
		const app = new App();
		const stack = new Stack(app, 'GovCloudArnStack');

		assert.doesNotThrow(
			() =>
				new Pipeline(
					stack,
					'TestPipeline',
					defaultPipelineProps({
						source: {
							repo: MOCK_REPO,
							connectionArn:
								'arn:aws-us-gov:codeconnections:us-gov-west-1:123456789012:connection/abc-def-123',
						},
					}),
				),
		);
	});

	it('accepts China region ARN format (arn:aws-cn:codeconnections:...)', () => {
		const app = new App();
		const stack = new Stack(app, 'ChinaArnStack');

		assert.doesNotThrow(
			() =>
				new Pipeline(
					stack,
					'TestPipeline',
					defaultPipelineProps({
						source: {
							repo: MOCK_REPO,
							connectionArn: 'arn:aws-cn:codeconnections:cn-north-1:123456789012:connection/abc-def-123',
						},
					}),
				),
		);
	});

	it('accepts standard commercial ARN format', () => {
		const app = new App();
		const stack = new Stack(app, 'StandardArnStack');

		assert.doesNotThrow(
			() =>
				new Pipeline(
					stack,
					'TestPipeline',
					defaultPipelineProps({
						source: {
							repo: MOCK_REPO,
							connectionArn: 'arn:aws:codeconnections:us-east-1:123456789012:connection/abc-def-123',
						},
					}),
				),
		);
	});

	it('rejects completely invalid ARN', () => {
		const app = new App();
		const stack = new Stack(app, 'InvalidArnStack');

		assert.throws(
			() =>
				new Pipeline(
					stack,
					'TestPipeline',
					defaultPipelineProps({
						source: {
							repo: MOCK_REPO,
							connectionArn: 'not-an-arn-at-all',
						},
					}),
				),
			/connectionArn.*must be a valid CodeConnections ARN/,
		);
	});
});

describe('cross-account validation', () => {
	it('does not throw when stage has no explicit env property', () => {
		const app = new App();
		const stack = new Stack(app, 'NoEnvStageStack');

		assert.doesNotThrow(
			() =>
				new Pipeline(
					stack,
					'TestPipeline',
					defaultPipelineProps({
						branches: [
							{
								branch: 'main',
								stages: [{ name: 'beta' }],
							},
						],
					}),
				),
		);
	});

	it('does not throw when pipeline stack has no explicit env (environment-agnostic)', () => {
		const app = new App();
		const stack = new Stack(app, 'AgnosticPipelineStack');

		assert.doesNotThrow(
			() =>
				new Pipeline(
					stack,
					'TestPipeline',
					defaultPipelineProps({
						branches: [
							{
								branch: 'main',
								stages: [
									{
										name: 'prod',
										env: { account: '222222222222', region: 'us-east-1' },
									},
								],
							},
						],
					}),
				),
		);
	});

	it('still throws on real cross-account mismatch without keys', () => {
		const app = new App();
		const stack = new Stack(app, 'RealCrossAccountStack', {
			env: { account: '111111111111', region: 'us-east-1' },
		});

		assert.throws(
			() =>
				new Pipeline(
					stack,
					'TestPipeline',
					defaultPipelineProps({
						crossAccountKeys: false,
						branches: [
							{
								branch: 'main',
								stages: [
									{
										name: 'prod',
										env: { account: '222222222222', region: 'us-east-1' },
									},
								],
							},
						],
					}),
				),
			/crossAccountKeys must be true/,
		);
	});
});

describe('synth defaults and DX warnings', () => {
	it('uses default commands ["npm ci", "npx cdk synth"] when commands not provided', () => {
		const app = new App();
		const stack = new Stack(app, 'DefaultCommandsStack');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				synth: undefined,
			}),
		);

		const template = Template.fromStack(stack);

		template.hasResourceProperties('AWS::CodeBuild::Project', {
			Source: Match.objectLike({
				BuildSpec: Match.serializedJson(
					Match.objectLike({
						phases: Match.objectLike({
							build: Match.objectLike({
								commands: Match.arrayWith(['npm ci', 'npx cdk synth']),
							}),
						}),
					}),
				),
			}),
		});
	});

	it('uses custom commands when provided', () => {
		const app = new App();
		const stack = new Stack(app, 'CustomCommandsStack');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				synth: {
					commands: ['yarn install', 'yarn cdk synth'],
				},
			}),
		);

		const template = Template.fromStack(stack);

		template.hasResourceProperties('AWS::CodeBuild::Project', {
			Source: Match.objectLike({
				BuildSpec: Match.serializedJson(
					Match.objectLike({
						phases: Match.objectLike({
							build: Match.objectLike({
								commands: Match.arrayWith(['yarn install', 'yarn cdk synth']),
							}),
						}),
					}),
				),
			}),
		});
	});

	it('passes installCommands to the ShellStep', () => {
		const app = new App();
		const stack = new Stack(app, 'InstallCommandsStack');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				synth: {
					installCommands: ['n 22'],
				},
			}),
		);

		const template = Template.fromStack(stack);

		template.hasResourceProperties('AWS::CodeBuild::Project', {
			Source: Match.objectLike({
				BuildSpec: Match.serializedJson(
					Match.objectLike({
						phases: Match.objectLike({
							install: Match.objectLike({
								commands: Match.arrayWith(['n 22']),
							}),
						}),
					}),
				),
			}),
		});
	});

	it('uses AMAZON_LINUX_2023_5 build image by default (provides Node 22)', () => {
		const app = new App();
		const stack = new Stack(app, 'DefaultImageStack');

		new Pipeline(stack, 'TestPipeline', defaultPipelineProps());

		const template = Template.fromStack(stack);

		template.hasResourceProperties('AWS::CodeBuild::Project', {
			Environment: Match.objectLike({
				Image: 'aws/codebuild/amazonlinux-x86_64-standard:5.0',
			}),
		});
	});

	it('allows overriding buildImage via synth config', () => {
		const app = new App();
		const stack = new Stack(app, 'CustomImageStack');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				synth: {
					buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
				},
			}),
		);

		const template = Template.fromStack(stack);

		template.hasResourceProperties('AWS::CodeBuild::Project', {
			Environment: Match.objectLike({
				Image: 'aws/codebuild/standard:7.0',
			}),
		});
	});

	it('emits CDK warning annotation when computeType is SMALL', () => {
		const app = new App();
		const stack = new Stack(app, 'SmallComputeStack');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				synth: {
					computeType: codebuild.ComputeType.SMALL,
				},
			}),
		);

		const annotations = Annotations.fromStack(stack);
		annotations.hasWarning('/SmallComputeStack/TestPipeline', Match.stringLikeRegexp('ComputeType\\.SMALL.*3GB'));
	});

	it('does not emit warning when computeType is MEDIUM (default)', () => {
		const app = new App();
		const stack = new Stack(app, 'MediumComputeStack');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				synth: {
					computeType: codebuild.ComputeType.MEDIUM,
				},
			}),
		);

		const annotations = Annotations.fromStack(stack);
		annotations.hasNoWarning('/MediumComputeStack/TestPipeline', Match.anyValue());
	});

	it('does not emit warning when computeType is not specified', () => {
		const app = new App();
		const stack = new Stack(app, 'NoComputeStack');

		new Pipeline(stack, 'TestPipeline', defaultPipelineProps());

		const annotations = Annotations.fromStack(stack);
		annotations.hasNoWarning('/NoComputeStack/TestPipeline', Match.anyValue());
	});
});

describe('stage stack discovery', () => {
	it('deploy action uses the stack name from the stage (not hardcoded)', () => {
		const app = new App();
		const stack = new Stack(app, 'DiscoverStack');

		new Pipeline(
			stack,
			'MyPipeline',
			defaultPipelineProps({
				branches: [
					{
						branch: 'main',
						stages: [{ name: 'prod' }],
					},
				],
				stageFactory: (scope) => {
					new Stack(scope, 'custom-prod-stack');
				},
			}),
		);

		const template = Template.fromStack(stack);

		template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
			Stages: Match.arrayWith([
				Match.objectLike({
					Actions: Match.arrayWith([
						Match.objectLike({
							ActionTypeId: Match.objectLike({
								Category: 'Deploy',
								Provider: 'CloudFormation',
							}),
							Configuration: Match.objectLike({
								StackName: Match.stringLikeRegexp('custom-prod-stack'),
							}),
						}),
					]),
				}),
			]),
		});
	});

	it('discovers multiple stacks in a single stage', () => {
		const app = new App();
		const stack = new Stack(app, 'MultiStackStage');

		new Pipeline(
			stack,
			'MyPipeline',
			defaultPipelineProps({
				branches: [
					{
						branch: 'main',
						stages: [{ name: 'prod' }],
					},
				],
				stageFactory: (scope) => {
					new Stack(scope, 'FrontendStack');
					new Stack(scope, 'BackendStack');
				},
			}),
		);

		const template = Template.fromStack(stack);
		const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
		const pipelineKey = Object.keys(pipelines)[0];
		const stages = (pipelines[pipelineKey] as any).Properties.Stages as any[];

		const deployStage = stages.find((s: any) => s.Name.includes('prod'));
		assert.ok(deployStage, 'Should have prod deploy stage');

		const deployActions = deployStage.Actions.filter(
			(a: any) => a.ActionTypeId?.Category === 'Deploy' && a.ActionTypeId?.Provider === 'CloudFormation',
		);
		assert.ok(
			deployActions.length >= 2,
			`Expected at least 2 deploy actions for 2 stacks, got ${deployActions.length}`,
		);

		const stackNames = deployActions.map((a: any) => a.Configuration?.StackName);
		assert.ok(
			stackNames.some((n: string) => n.includes('FrontendStack')),
			`Expected a deploy action for FrontendStack, found: ${stackNames.join(', ')}`,
		);
		assert.ok(
			stackNames.some((n: string) => n.includes('BackendStack')),
			`Expected a deploy action for BackendStack, found: ${stackNames.join(', ')}`,
		);
	});

	it('throws when stageFactory produces no stacks', () => {
		const app = new App();
		const stack = new Stack(app, 'EmptyStageStack');

		assert.throws(
			() =>
				new Pipeline(
					stack,
					'TestPipeline',
					defaultPipelineProps({
						stageFactory: () => {
							// Intentionally empty — creates no stacks
						},
					}),
				),
			/stage.*beta.*contains no stacks/i,
		);
	});

	it('uses user-chosen stack name regardless of naming convention', () => {
		const app = new App();
		const stack = new Stack(app, 'UserNameStack');

		new Pipeline(
			stack,
			'Pipe',
			defaultPipelineProps({
				branches: [
					{
						branch: 'main',
						stages: [{ name: 'beta' }],
					},
				],
				stageFactory: (scope) => {
					new Stack(scope, 'blocks-pipeline-demo-prod');
				},
			}),
		);

		const template = Template.fromStack(stack);

		template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
			Stages: Match.arrayWith([
				Match.objectLike({
					Actions: Match.arrayWith([
						Match.objectLike({
							ActionTypeId: Match.objectLike({
								Category: 'Deploy',
								Provider: 'CloudFormation',
							}),
							Configuration: Match.objectLike({
								StackName: Match.stringLikeRegexp('blocks-pipeline-demo-prod'),
							}),
						}),
					]),
				}),
			]),
		});
	});
});

describe('additional validation tests', () => {
	it('throws when both stageFactory and appFile are provided', () => {
		const app = new App();
		const stack = new Stack(app, 'BothFactoryAndAppFileStack');

		assert.throws(
			() =>
				new Pipeline(stack, 'P', {
					source: {
						repo: MOCK_REPO,
						connectionArn: MOCK_CONNECTION_ARN,
					},
					branches: [{ branch: 'main', stages: [{ name: 'prod' }] }],
					stageFactory: minimalStageFactory,
					appFile: './index.cdk.ts',
				}),
			/stageFactory.*appFile|appFile.*stageFactory/,
		);
	});

	it('throws when appFile is used with sync constructor', () => {
		const app = new App();
		const stack = new Stack(app, 'AppFileSyncStack');

		assert.throws(
			() =>
				new Pipeline(stack, 'P', {
					source: {
						repo: MOCK_REPO,
						connectionArn: MOCK_CONNECTION_ARN,
					},
					branches: [{ branch: 'main', stages: [{ name: 'prod' }] }],
					appFile: './index.cdk.ts',
				}),
			/Pipeline\.create/,
		);
	});

	it('throws when triggerOnPush is true with triggerFilters', () => {
		const app = new App();
		const stack = new Stack(app, 'TriggerConflictStack');

		assert.throws(
			() =>
				new Pipeline(stack, 'P', {
					source: {
						repo: MOCK_REPO,
						connectionArn: MOCK_CONNECTION_ARN,
						triggerFilters: ['src/**'],
					},
					branches: [{ branch: 'main', stages: [{ name: 'prod' }], triggerOnPush: true }],
					stageFactory: minimalStageFactory,
				}),
			/triggerOnPush/,
		);
	});

	it('throws on invalid stage name characters', () => {
		const app = new App();
		const stack = new Stack(app, 'InvalidStageNameStack');

		assert.throws(
			() =>
				new Pipeline(stack, 'P', {
					source: {
						repo: MOCK_REPO,
						connectionArn: MOCK_CONNECTION_ARN,
					},
					branches: [{ branch: 'main', stages: [{ name: 'prod/v2' }] }],
					stageFactory: minimalStageFactory,
				}),
			/invalid characters/,
		);
	});

	it('throws on duplicate branch IDs after sanitization', () => {
		const app = new App();
		const stack = new Stack(app, 'DuplicateBranchIdStack');

		assert.throws(
			() =>
				new Pipeline(stack, 'P', {
					source: {
						repo: MOCK_REPO,
						connectionArn: MOCK_CONNECTION_ARN,
					},
					branches: [
						{ branch: 'feature/foo', stages: [{ name: 'beta' }] },
						{ branch: 'feature_foo', stages: [{ name: 'beta' }] },
					],
					stageFactory: minimalStageFactory,
				}),
			/duplicate ID/,
		);
	});

	it('accepts legacy codestar-connections ARN format', () => {
		const app = new App();
		const stack = new Stack(app, 'LegacyArnStack');

		assert.doesNotThrow(
			() =>
				new Pipeline(stack, 'P', {
					source: {
						repo: MOCK_REPO,
						connectionArn: 'arn:aws:codestar-connections:us-east-1:123456789012:connection/abc-def-123',
					},
					branches: [{ branch: 'main', stages: [{ name: 'prod' }] }],
					stageFactory: minimalStageFactory,
				}),
		);
	});
});

describe('validateAppFilePath', () => {
	let tmpDir: string;
	let originalCwd: string;

	before(() => {
		originalCwd = process.cwd();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
		process.chdir(tmpDir);

		fs.writeFileSync(path.join(tmpDir, 'index.cdk.ts'), '');
		fs.writeFileSync(path.join(tmpDir, 'app.js'), '');
		fs.writeFileSync(path.join(tmpDir, 'app.mjs'), '');
		fs.writeFileSync(path.join(tmpDir, 'app.cjs'), '');
		fs.mkdirSync(path.join(tmpDir, 'infra'));
		fs.writeFileSync(path.join(tmpDir, 'infra', 'stack.ts'), '');
		fs.writeFileSync(path.join(tmpDir, 'data.json'), '');
		fs.writeFileSync(path.join(os.tmpdir(), 'outside.ts'), '');
	});

	after(() => {
		process.chdir(originalCwd);
		fs.rmSync(tmpDir, { recursive: true, force: true });
		try {
			fs.unlinkSync(path.join(os.tmpdir(), 'outside.ts'));
		} catch {
			/* ignore */
		}
	});

	it('accepts .ts, .js, .mjs, .cjs extensions', () => {
		assert.doesNotThrow(() => validateAppFilePath(path.join(tmpDir, 'index.cdk.ts')));
		assert.doesNotThrow(() => validateAppFilePath(path.join(tmpDir, 'app.js')));
		assert.doesNotThrow(() => validateAppFilePath(path.join(tmpDir, 'app.mjs')));
		assert.doesNotThrow(() => validateAppFilePath(path.join(tmpDir, 'app.cjs')));
	});

	it('rejects non-module file extensions', () => {
		assert.throws(
			() => validateAppFilePath(path.join(tmpDir, 'data.json')),
			/must have a module extension.*Got '\.json'/,
		);
	});

	it('accepts files inside the project root', () => {
		assert.doesNotThrow(() => validateAppFilePath(path.join(tmpDir, 'infra', 'stack.ts')));
	});

	it('rejects files outside the project root', () => {
		assert.throws(
			() => validateAppFilePath(path.join(os.tmpdir(), 'outside.ts')),
			/must be inside the project root/,
		);
	});

	it('rejects symlinks that resolve outside the project root', () => {
		const symlinkPath = path.join(tmpDir, 'link-escape.ts');
		fs.symlinkSync(path.join(os.tmpdir(), 'outside.ts'), symlinkPath);
		try {
			assert.throws(() => validateAppFilePath(symlinkPath), /must be inside the project root/);
		} finally {
			fs.unlinkSync(symlinkPath);
		}
	});
});

describe('synth partialBuildSpec', () => {
	it('declares the Node.js 22 runtime in the synth buildspec by default', () => {
		const app = new App();
		const stack = new Stack(app, 'DefaultPartialBuildSpecStack');

		new Pipeline(stack, 'TestPipeline', defaultPipelineProps());

		const template = Template.fromStack(stack);

		template.hasResourceProperties('AWS::CodeBuild::Project', {
			Source: Match.objectLike({
				BuildSpec: Match.serializedJson(
					Match.objectLike({
						phases: Match.objectLike({
							install: Match.objectLike({
								'runtime-versions': Match.objectLike({ nodejs: 22 }),
							}),
						}),
					}),
				),
			}),
		});
	});

	it('omits runtime-versions entirely when partialBuildSpec is null (explicit opt-out)', () => {
		const app = new App();
		const stack = new Stack(app, 'NullOptOutBuildSpecStack');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				synth: {
					partialBuildSpec: null,
				},
			}),
		);

		const template = Template.fromStack(stack);

		// With the null opt-out, the Node.js 22 default must NOT be injected:
		// no CodeBuild project's buildspec should declare runtime-versions.
		const projects = template.findResources('AWS::CodeBuild::Project');
		const buildSpecs = Object.values(projects)
			.map((p: any) => p.Properties?.Source?.BuildSpec)
			.filter((b: unknown): b is string => typeof b === 'string');

		assert.ok(buildSpecs.length > 0, 'Expected at least one CodeBuild project with an inline buildspec');
		for (const spec of buildSpecs) {
			assert.ok(
				!spec.includes('runtime-versions'),
				`Expected no runtime-versions in any synth buildspec when opting out with null, but found: ${spec}`,
			);
		}
	});

	it('honors a custom partialBuildSpec override (Node.js 20)', () => {
		const app = new App();
		const stack = new Stack(app, 'CustomPartialBuildSpecStack');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				synth: {
					partialBuildSpec: codebuild.BuildSpec.fromObject({
						phases: { install: { 'runtime-versions': { nodejs: 20 } } },
					}),
				},
			}),
		);

		const template = Template.fromStack(stack);

		template.hasResourceProperties('AWS::CodeBuild::Project', {
			Source: Match.objectLike({
				BuildSpec: Match.serializedJson(
					Match.objectLike({
						phases: Match.objectLike({
							install: Match.objectLike({
								'runtime-versions': Match.objectLike({ nodejs: 20 }),
							}),
						}),
					}),
				),
			}),
		});
	});

	it('does not retain the default Node.js 22 runtime when overridden', () => {
		const app = new App();
		const stack = new Stack(app, 'OverrideReplacesDefaultStack');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				synth: {
					partialBuildSpec: codebuild.BuildSpec.fromObject({
						phases: { install: { 'runtime-versions': { nodejs: 20 } } },
					}),
				},
			}),
		);

		const template = Template.fromStack(stack);
		const projects = template.findResources('AWS::CodeBuild::Project');
		const buildSpecs = Object.values(projects)
			.map((p: any) => p.Properties?.Source?.BuildSpec)
			.filter((b: unknown): b is string => typeof b === 'string');

		const synthSpec = buildSpecs.find((b) => b.includes('runtime-versions'));
		assert.ok(synthSpec, 'Expected a synth buildspec declaring runtime-versions');

		const parsed = JSON.parse(synthSpec);
		assert.strictEqual(
			parsed.phases.install['runtime-versions'].nodejs,
			20,
			'Custom partialBuildSpec should replace the default Node.js 22 runtime',
		);
	});

	it('keeps partialBuildSpec (buildspec) orthogonal to the NODE_OPTIONS env var', () => {
		const app = new App();
		const stack = new Stack(app, 'OrthogonalBuildSpecStack');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				synth: {
					env: { NODE_OPTIONS: '--max-old-space-size=4096' },
				},
			}),
		);

		const template = Template.fromStack(stack);

		// The Node.js 22 runtime (buildspec) and the merged NODE_OPTIONS env var
		// both appear on the same synth CodeBuild project.
		template.hasResourceProperties('AWS::CodeBuild::Project', {
			Source: Match.objectLike({
				BuildSpec: Match.serializedJson(
					Match.objectLike({
						phases: Match.objectLike({
							install: Match.objectLike({
								'runtime-versions': Match.objectLike({ nodejs: 22 }),
							}),
						}),
					}),
				),
			}),
			Environment: Match.objectLike({
				EnvironmentVariables: Match.arrayWith([
					Match.objectLike({
						Name: 'NODE_OPTIONS',
						Value: '--conditions=cdk --max-old-space-size=4096',
					}),
				]),
			}),
		});
	});

	it('merges runtime-versions with custom installCommands', () => {
		const app = new App();
		const stack = new Stack(app, 'InstallCommandsMergeStack');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				synth: {
					installCommands: ['corepack enable'],
				},
			}),
		);

		const template = Template.fromStack(stack);

		template.hasResourceProperties('AWS::CodeBuild::Project', {
			Source: Match.objectLike({
				BuildSpec: Match.serializedJson(
					Match.objectLike({
						phases: Match.objectLike({
							install: Match.objectLike({
								'runtime-versions': Match.objectLike({ nodejs: 22 }),
								commands: Match.arrayWith(['corepack enable']),
							}),
						}),
					}),
				),
			}),
		});
	});
});

describe('_sourceOverride (internal test hook)', () => {
	it('substitutes the GitHub source with the provided producer (S3)', () => {
		const app = new App();
		const stack = new Stack(app, 'SourceOverrideStack');
		const bucket = new Bucket(stack, 'SourceBucket');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				_sourceOverride: CodePipelineSource.s3(bucket, 'source.zip'),
			}),
		);

		const template = Template.fromStack(stack);

		template.hasResourceProperties('AWS::CodePipeline::Pipeline', {
			Stages: Match.arrayWith([
				Match.objectLike({
					Name: 'Source',
					Actions: Match.arrayWith([
						Match.objectLike({
							ActionTypeId: Match.objectLike({ Provider: 'S3' }),
						}),
					]),
				}),
			]),
		});
	});

	it('does not create a CodeStarSourceConnection action when overridden', () => {
		const app = new App();
		const stack = new Stack(app, 'SourceOverrideNoConnectionStack');
		const bucket = new Bucket(stack, 'SourceBucket');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				_sourceOverride: CodePipelineSource.s3(bucket, 'source.zip'),
			}),
		);

		const template = Template.fromStack(stack);
		const pipelines = template.findResources('AWS::CodePipeline::Pipeline');
		const providers = Object.values(pipelines)
			.flatMap((p: any) => p.Properties?.Stages ?? [])
			.flatMap((s: any) => s.Actions ?? [])
			.map((a: any) => a.ActionTypeId?.Provider);

		assert.ok(
			!providers.includes('CodeStarSourceConnection'),
			`Expected no CodeStarSourceConnection action when _sourceOverride is set, got providers: ${providers.join(', ')}`,
		);
	});

	it('still synthesizes a single CodePipeline when source is overridden', () => {
		const app = new App();
		const stack = new Stack(app, 'SourceOverrideSynthStack');
		const bucket = new Bucket(stack, 'SourceBucket');

		new Pipeline(
			stack,
			'TestPipeline',
			defaultPipelineProps({
				_sourceOverride: CodePipelineSource.s3(bucket, 'source.zip'),
			}),
		);

		const template = Template.fromStack(stack);
		template.resourceCountIs('AWS::CodePipeline::Pipeline', 1);
	});

	it('still validates the connection ARN even when _sourceOverride is set', () => {
		const app = new App();
		const stack = new Stack(app, 'SourceOverrideArnValidationStack');
		const bucket = new Bucket(stack, 'SourceBucket');

		// _sourceOverride bypasses the GitHub source at synth time, but `source`
		// (repo + connectionArn) is still required and validated so production
		// configs stay well-formed. An invalid ARN must still throw.
		assert.throws(
			() =>
				new Pipeline(
					stack,
					'TestPipeline',
					defaultPipelineProps({
						source: {
							repo: MOCK_REPO,
							connectionArn: 'not-an-arn-at-all',
						},
						_sourceOverride: CodePipelineSource.s3(bucket, 'source.zip'),
					}),
				),
			/connectionArn.*must be a valid CodeConnections ARN/,
		);
	});

	// ── connectionArn as a secret() (Phase 3) ───────────────────────
	describe('connectionArn secret()', () => {
		it('rejects a secret() connectionArn on the sync constructor', () => {
			const stack = new Stack(new App(), 'SyncSecretStack');
			assert.throws(
				() =>
					new Pipeline(
						stack,
						'P',
						defaultPipelineProps({
							source: { repo: MOCK_REPO, connectionArn: secret('CONNECTION_ARN') },
						}),
					),
				/requires the async path.*Pipeline\.create/s,
			);
		});

		it('resolves a secret() connectionArn at synth time via Pipeline.create()', async () => {
			const app = new App();
			// Resolve the synth-time fetcher to a valid ARN without hitting SSM.
			_setSynthSecretFetcher(async () => MOCK_CONNECTION_ARN);
			try {
				const pipeline = await Pipeline.create(
					app,
					'AsyncSecretPipeline',
					defaultPipelineProps({
						source: { repo: MOCK_REPO, connectionArn: secret('CONNECTION_ARN') },
					}),
				);
				// The resolved ARN reached the CodePipeline source action.
				const stack = pipeline.node.scope as Stack;
				const t = Template.fromStack(stack);
				const json = JSON.stringify(t.toJSON());
				assert.ok(json.includes('test-connection-id'), 'resolved ARN should be wired into the source');
			} finally {
				_setSynthSecretFetcher(null);
			}
		});
	});
});
