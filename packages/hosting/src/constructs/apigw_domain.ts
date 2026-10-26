/**
 * Shared custom-domain wiring for the API Gateway front doors (REST + HTTP).
 *
 * Unlike the CloudFront door — whose ACM certificate must live in us-east-1 and
 * whose Route 53 alias targets a distribution — an API Gateway custom domain is
 * **regional**: the certificate must be in the *stack's* region and the alias
 * targets the gateway's own regional domain. This helper resolves the hosted
 * zone and a regional certificate (BYO or DNS-validated), so each flavor's
 * construct only has to create its own `DomainName` + mapping + alias records.
 */
import { Certificate, CertificateValidation, type ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone, type IHostedZone } from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';
import { HostingError } from '../hosting_error.js';

/** Custom-domain inputs for an API Gateway front door (threaded from `HostingProps.domain`). */
export type ApiGwCustomDomain = {
	/** One or more custom domain names; the first is the primary (the door's URL). */
	names: string[];
	/** Route 53 hosted zone domain (e.g. `example.com`) — enables automatic DNS records + cert. */
	hostedZone?: string;
	/** Route 53 hosted zone ID — avoids `fromLookup()` (no `env` needed on the stack). */
	hostedZoneId?: string;
	/** BYO **regional** ACM certificate (same region as the stack). Auto-created via DNS validation when omitted and a zone is resolvable. */
	certificate?: ICertificate;
};

/** Resolved regional certificate + (optional) hosted zone for a set of custom domain names. */
export type ResolvedApiGwDomain = {
	certificate: ICertificate;
	hostedZone?: IHostedZone;
	names: string[];
};

/** Reject a domain name that is not the apex of, or a subdomain within, the hosted zone. */
const validateWithinZone = (domainName: string, hostedZone: string): void => {
	if (domainName !== hostedZone && !domainName.endsWith(`.${hostedZone}`)) {
		throw new HostingError('InvalidDomainConfigError', {
			message: `Domain name '${domainName}' is not within hosted zone '${hostedZone}'.`,
			resolution: `Ensure each domain name ends with the hosted zone (e.g. hostedZone 'example.com' → 'example.com' or 'app.example.com').`,
		});
	}
};

/**
 * Resolve the hosted zone (by id, by name, or none) and a **regional** ACM
 * certificate (BYO, else DNS-validated against the zone) covering every name.
 * A regional API Gateway custom domain needs a same-region cert — so, unlike
 * the CloudFront door, this never forces us-east-1.
 */
export const resolveApiGwDomain = (scope: Construct, id: string, domain: ApiGwCustomDomain): ResolvedApiGwDomain => {
	const names = domain.names;
	if (domain.hostedZone) {
		for (const name of names) validateWithinZone(name, domain.hostedZone);
	}

	let hostedZone: IHostedZone | undefined;
	if (domain.hostedZoneId) {
		hostedZone = HostedZone.fromHostedZoneAttributes(scope, `${id}Zone`, {
			hostedZoneId: domain.hostedZoneId,
			zoneName: domain.hostedZone ?? names[0],
		});
	} else if (domain.hostedZone) {
		hostedZone = HostedZone.fromLookup(scope, `${id}Zone`, { domainName: domain.hostedZone });
	}

	let certificate: ICertificate;
	if (domain.certificate) {
		certificate = domain.certificate;
	} else if (hostedZone) {
		// Regional (stack-region) cert, DNS-validated against the zone. Not the
		// deprecated DnsValidatedCertificate/us-east-1 path the CloudFront door uses.
		certificate = new Certificate(scope, `${id}Cert`, {
			domainName: names[0],
			subjectAlternativeNames: names.length > 1 ? names.slice(1) : undefined,
			validation: CertificateValidation.fromDns(hostedZone),
		});
	} else {
		throw new HostingError('MissingCertificateError', {
			message: 'A regional (stack-region) certificate is required when neither hostedZone nor hostedZoneId is provided.',
			resolution: 'Provide `certificate` for a BYO domain, or specify `hostedZone` / `hostedZoneId` for automatic provisioning.',
		});
	}

	return { certificate, hostedZone, names };
};
