// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Electric container image for `sync`.
 *
 * By default the stack builds Electric itself, in the deploying account:
 * a CodeBuild project builds the pinned Electric release from its GitHub
 * source tag and pushes it to a stack-owned ECR repository. The build uses
 * base images from the ECR Public mirror of the Docker official images, so it
 * needs no registry credentials and no local Docker.
 *
 * A custom resource starts the build and waits for it, so the Fargate service
 * is created only after the image exists. The image tag encodes the Electric
 * version and the Dockerfile, so a deploy rebuilds only when either changes.
 *
 * Pass `sync.electric.image` to use a prebuilt image instead.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as cr from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';

/** Pinned Electric release. Bump deliberately; see the Electric changelog. */
export const DEFAULT_ELECTRIC_VERSION = '1.8.1';

/**
 * Builds the Electric sync service from its source tag. Mirrors
 * `packages/sync-service/Dockerfile` in electric-sql/electric, with base images
 * from the ECR Public mirror of the Docker official images.
 */
export const ELECTRIC_DOCKERFILE = `ARG BASE_IMAGE=public.ecr.aws/docker/library/elixir:1.20.4-otp-29
ARG RUNNER_IMAGE=public.ecr.aws/docker/library/elixir:1.20.4-otp-29-slim

FROM \${BASE_IMAGE} AS builder
ARG ELECTRIC_VERSION
RUN apt-get update -y && apt-get install -y build-essential git curl && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN mix local.hex --force && mix local.rebar --force
ENV MIX_ENV=prod MIX_TARGET=application ELECTRIC_VERSION=\${ELECTRIC_VERSION}
WORKDIR /src
RUN curl -fsSL "https://github.com/electric-sql/electric/archive/refs/tags/%40core%2Fsync-service%40\${ELECTRIC_VERSION}.tar.gz" \\
  | tar xz --strip-components=1
WORKDIR /src/packages/sync-service
# Same order as upstream: config.exs reads Electric.MixProject, so it must not
# be present while dependencies compile; runtime.exs joins only for the release.
RUN mkdir /tmp/config && mv config/* /tmp/config/
RUN mix deps.get && MIX_OS_DEPS_COMPILE_PARTITION_COUNT=4 mix deps.compile
RUN cp /tmp/config/config.exs config/ && mix compile && mix sentry.package_source_code
RUN cp /tmp/config/runtime.exs config/ && mix release

FROM \${RUNNER_IMAGE}
RUN apt-get update -y && apt-get install -y libstdc++6 openssl locales ca-certificates curl \\
  && apt-get clean && rm -rf /var/lib/apt/lists/* \\
  && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8 MIX_ENV=prod MIX_TARGET=application
WORKDIR /app
RUN chown nobody /app
COPY --from=builder --chown=nobody /src/packages/sync-service/_build/application_prod/rel/electric ./
RUN mv /app/bin/electric /app/bin/entrypoint
USER nobody
ENTRYPOINT ["/app/bin/entrypoint"]
CMD ["start"]
`;

/**
 * Starts the CodeBuild build on create/update and polls it to completion.
 * Inline so the function needs no bundling; the Node.js runtime provides the SDK.
 */
const BUILD_WAITER_CODE = `
const { CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand } = require('@aws-sdk/client-codebuild');
const client = new CodeBuildClient({});
exports.onEvent = async (event) => {
  const tag = event.ResourceProperties.imageTag;
  if (event.RequestType === 'Delete') return { PhysicalResourceId: event.PhysicalResourceId || tag };
  const { build } = await client.send(new StartBuildCommand({ projectName: event.ResourceProperties.projectName }));
  console.log('Started Electric image build', build.id, 'tag', tag);
  return { PhysicalResourceId: tag, Data: { BuildId: build.id, ImageTag: tag } };
};
exports.isComplete = async (event) => {
  if (event.RequestType === 'Delete') return { IsComplete: true };
  const buildId = event.Data && event.Data.BuildId;
  const { builds } = await client.send(new BatchGetBuildsCommand({ ids: [buildId] }));
  const build = builds && builds[0];
  const status = build ? build.buildStatus : 'UNKNOWN';
  console.log('Electric image build', buildId, status);
  if (status === 'IN_PROGRESS') return { IsComplete: false };
  if (status === 'SUCCEEDED') return { IsComplete: true, Data: { ImageTag: event.Data.ImageTag } };
  const logs = build && build.logs && build.logs.deepLink;
  throw new Error('Electric image build ' + buildId + ' ended with ' + status + (logs ? '. Logs: ' + logs : ''));
};
`;

/** Options for {@link electricImage}. */
export interface ElectricImageOptions {
  /** Prefix for construct ids. */
  id: (suffix: string) => string;
  /** Electric release to build. */
  version: string;
  /** Prebuilt image; skips the in-account build. */
  image?: string;
  logRetention?: cdk.aws_logs.RetentionDays;
}

/** The image for the Electric task, plus what the service must wait for. */
export interface ElectricImage {
  image: ecs.ContainerImage;
  cpuArchitecture: ecs.CpuArchitecture;
  /** The build custom resource; the service depends on it. */
  build?: cdk.CustomResource;
}

/** Resolve the Electric image: a prebuilt one, or a build in this account. */
export function electricImage(scope: Construct, options: ElectricImageOptions): ElectricImage {
  const { id, version } = options;
  if (options.image) {
    return { image: ecs.ContainerImage.fromRegistry(options.image), cpuArchitecture: ecs.CpuArchitecture.X86_64 };
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Invalid Electric version "${version}"; expected "MAJOR.MINOR.PATCH" like "${DEFAULT_ELECTRIC_VERSION}".`);
  }

  const dockerfileHash = createHash('sha256').update(ELECTRIC_DOCKERFILE).digest('hex').slice(0, 8);
  const imageTag = `${version}-${dockerfileHash}`;

  // The build context is just the Dockerfile; the source is fetched by tag inside the build.
  const contextDir = join(tmpdir(), `aws-blocks-electric-${dockerfileHash}`);
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(contextDir, 'Dockerfile'), ELECTRIC_DOCKERFILE);
  const source = new s3assets.Asset(scope, id('ImageSource'), { path: contextDir });

  const repository = new ecr.Repository(scope, id('ImageRepo'), {
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    emptyOnDelete: true,
    lifecycleRules: [{ maxImageCount: 5 }],
  });

  const project = new codebuild.Project(scope, id('ImageBuild'), {
    description: `Builds Electric ${version} for AWS Blocks sync`,
    source: codebuild.Source.s3({ bucket: source.bucket, path: source.s3ObjectKey }),
    environment: {
      // Arm build for an Arm (Graviton) Fargate task: native, faster, and cheaper.
      buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
      computeType: codebuild.ComputeType.LARGE,
      privileged: true,
    },
    environmentVariables: {
      REPO_URI: { value: repository.repositoryUri },
      IMAGE_TAG: { value: imageTag },
      ELECTRIC_VERSION: { value: version },
    },
    timeout: cdk.Duration.minutes(60),
    logging: {
      cloudWatch: {
        logGroup: new LogGroup(scope, id('ImageBuildLogs'), {
          retention: options.logRetention,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    },
    buildSpec: codebuild.BuildSpec.fromObject({
      version: '0.2',
      phases: {
        pre_build: {
          commands: [
            // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion in the build container
            'aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${REPO_URI%%/*}"',
          ],
        },
        build: {
          commands: [
            // Idempotent: a retried or replayed build reuses an existing tag.
            'if docker manifest inspect "$REPO_URI:$IMAGE_TAG" > /dev/null 2>&1; then echo "Image exists"; else ' +
              'docker build --build-arg ELECTRIC_VERSION="$ELECTRIC_VERSION" -t "$REPO_URI:$IMAGE_TAG" . && ' +
              'docker push "$REPO_URI:$IMAGE_TAG"; fi',
          ],
        },
      },
    }),
  });
  repository.grantPullPush(project);
  source.grantRead(project);

  const waiter = (handler: 'onEvent' | 'isComplete') =>
    new lambda.Function(scope, id(handler === 'onEvent' ? 'ImageBuildStart' : 'ImageBuildWait'), {
      runtime: DEFAULT_NODE_RUNTIME,
      handler: `index.${handler}`,
      code: lambda.Code.fromInline(BUILD_WAITER_CODE),
      timeout: cdk.Duration.minutes(1),
      logGroup: new LogGroup(scope, id(handler === 'onEvent' ? 'ImageBuildStartLogs' : 'ImageBuildWaitLogs'), {
        retention: options.logRetention,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
  const onEvent = waiter('onEvent');
  const isComplete = waiter('isComplete');
  onEvent.addToRolePolicy(new iam.PolicyStatement({ actions: ['codebuild:StartBuild'], resources: [project.projectArn] }));
  isComplete.addToRolePolicy(new iam.PolicyStatement({ actions: ['codebuild:BatchGetBuilds'], resources: [project.projectArn] }));

  const provider = new cr.Provider(scope, id('ImageBuildProvider'), {
    onEventHandler: onEvent,
    isCompleteHandler: isComplete,
    queryInterval: cdk.Duration.seconds(30),
    totalTimeout: cdk.Duration.hours(1),
  });
  const build = new cdk.CustomResource(scope, id('ImageBuildRun'), {
    serviceToken: provider.serviceToken,
    properties: { projectName: project.projectName, imageTag },
  });

  return {
    image: ecs.ContainerImage.fromEcrRepository(repository, imageTag),
    cpuArchitecture: ecs.CpuArchitecture.ARM64,
    build,
  };
}
