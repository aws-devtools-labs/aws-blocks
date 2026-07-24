// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mint a Supabase-style HS256 access token for the demo.
 * Usage: node demo/mint.mjs [secret] [supabaseUrl] [sub] [email] [role]
 */
import { SignJWT } from 'jose';

const [
	,
	,
	secret = 'demo-supabase-jwt-secret',
	url = 'https://proj.supabase.co',
	sub = '11111111-2222-3333-4444-555555555555',
	email = 'alice@example.com',
	role = 'authenticated',
] = process.argv;

const token = await new SignJWT({ email, role })
	.setProtectedHeader({ alg: 'HS256' })
	.setIssuer(`${url.replace(/\/+$/, '')}/auth/v1`)
	.setAudience('authenticated')
	.setSubject(sub)
	.setIssuedAt()
	.setExpirationTime('2h')
	.sign(new TextEncoder().encode(secret));

console.log(token);
