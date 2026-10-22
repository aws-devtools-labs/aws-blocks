// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Compute Smoke runs share BlocksComputeTestVpc without a lock because its
// endpoints are permanent. Pin their shape: private DNS on (else the runtimes
// go through the NAT gateway and compute-smoke stops testing the endpoints),
// every route table on the gateway endpoints, 443 only on the interface
// endpoints. BlocksTestVpc must stay without endpoints: the apps that use it
// create their own.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildTestVpcStacks, COMPUTE_TEST_VPC_ENDPOINTS, endpointServiceName } from './vpc-test-stack.js';

const ENDPOINT = 'AWS::EC2::VPCEndpoint';

function synth() {
  const stacks = buildTestVpcStacks(new cdk.App(), { account: '111111111111', region: 'us-east-1' });
  return {
    testVpc: Template.fromStack(stacks.testVpc),
    computeTestVpc: Template.fromStack(stacks.computeTestVpc),
    endpoints: Template.fromStack(stacks.computeTestVpcEndpoints),
  };
}

const serviceName = (props: { ServiceName: unknown }) => endpointServiceName(props.ServiceName);

function endpointsOfType(template: Template, type: 'Gateway' | 'Interface') {
  return Object.values(template.findResources(ENDPOINT, { Properties: { VpcEndpointType: type } })).map(
    (r) => r.Properties,
  );
}

describe('persistent test VPCs', () => {
  test('endpointServiceName reads literal and region-joined service names', () => {
    assert.equal(endpointServiceName('com.amazonaws.us-east-1.ecr.api'), 'ecr.api');
    assert.equal(endpointServiceName({ 'Fn::Join': ['', ['com.amazonaws.', { Ref: 'AWS::Region' }, '.s3']] }), 's3');
  });

  test('BlocksTestVpc has no endpoints', () => {
    const { testVpc } = synth();
    testVpc.resourceCountIs(ENDPOINT, 0);
  });

  test('BlocksComputeTestVpc keeps its endpoints in their own stack', () => {
    const { computeTestVpc, endpoints } = synth();
    computeTestVpc.resourceCountIs(ENDPOINT, 0);
    endpoints.resourceCountIs('AWS::EC2::VPC', 0);
    endpoints.resourceCountIs(
      ENDPOINT,
      COMPUTE_TEST_VPC_ENDPOINTS.gateway.length + COMPUTE_TEST_VPC_ENDPOINTS.interface.length,
    );
  });

  test('gateway endpoints are S3 and DynamoDB, on the route tables of all six subnets', () => {
    const { endpoints } = synth();
    const gateways = endpointsOfType(endpoints, 'Gateway');
    assert.deepEqual(gateways.map(serviceName).sort(), [...COMPUTE_TEST_VPC_ENDPOINTS.gateway]);
    for (const gw of gateways) {
      assert.equal(gw.RouteTableIds.length, 6, `${serviceName(gw)}: one route per subnet route table`);
      // Both private (Lambda + Fargate) subnets' route tables must be among them.
      const ids = JSON.stringify(gw.RouteTableIds);
      assert.match(ids, /privateSubnet1RouteTable/);
      assert.match(ids, /privateSubnet2RouteTable/);
    }
  });

  test('interface endpoints are SQS and Logs, private DNS on, in the private subnets, behind one SG', () => {
    const { endpoints } = synth();
    const interfaces = endpointsOfType(endpoints, 'Interface');
    assert.deepEqual(interfaces.map(serviceName).sort(), [...COMPUTE_TEST_VPC_ENDPOINTS.interface]);
    const [sgId] = Object.keys(endpoints.findResources('AWS::EC2::SecurityGroup'));
    for (const ep of interfaces) {
      assert.equal(ep.PrivateDnsEnabled, true, `${serviceName(ep)}: private DNS`);
      assert.equal(ep.SubnetIds.length, 2);
      assert.match(JSON.stringify(ep.SubnetIds), /privateSubnet1Subnet.*privateSubnet2Subnet/);
      assert.deepEqual(ep.SecurityGroupIds, [{ 'Fn::GetAtt': [sgId, 'GroupId'] }]);
    }
  });

  test('the endpoint security group admits 443 from the VPC CIDR and nothing else', () => {
    const { endpoints } = synth();
    endpoints.resourceCountIs('AWS::EC2::SecurityGroup', 1);
    endpoints.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    endpoints.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: [
        {
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
          CidrIp: { 'Fn::ImportValue': Match.stringLikeRegexp('CidrBlock') },
          Description: 'HTTPS from the VPC',
        },
      ],
    });
  });

  test('both stacks are tagged do-not-delete', () => {
    const { computeTestVpc, endpoints } = synth();
    computeTestVpc.hasResourceProperties('AWS::EC2::VPC', {
      Tags: Match.arrayWith([{ Key: 'blocks:do-not-delete', Value: 'true' }]),
    });
    endpoints.hasResourceProperties('AWS::EC2::SecurityGroup', {
      Tags: Match.arrayWith([{ Key: 'blocks:do-not-delete', Value: 'true' }]),
    });
  });
});
