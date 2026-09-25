// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate a generated OpenRPC document for structural conformance.
 *
 * Checks:
 * - Required top-level fields (openrpc, info, methods)
 * - OpenRPC version format
 * - Method structure (name, params, result)
 * - Param structure (name, required, schema)
 * - Result structure (name, schema)
 * - All $ref pointers resolve to entries in components.schemas
 * - No `nullable` field (should use oneOf with null instead)
 * - Method names are namespace-qualified (contain a dot)
 * - Result names are descriptive (not just "result")
 *
 * Returns an array of error messages. Empty array = valid.
 */

export interface SpecValidationError {
	path: string;
	message: string;
}

export function validateSpec(doc: any): SpecValidationError[] {
	const errors: SpecValidationError[] = [];

	// Top-level required fields
	if (!doc || typeof doc !== 'object') {
		return [{ path: '', message: 'Document must be an object' }];
	}

	if (typeof doc.openrpc !== 'string') {
		errors.push({ path: 'openrpc', message: 'Missing or invalid "openrpc" version string' });
	} else if (!/^\d+\.\d+\.\d+$/.test(doc.openrpc)) {
		errors.push({ path: 'openrpc', message: `Invalid version format: "${doc.openrpc}"` });
	}

	if (!doc.info || typeof doc.info !== 'object') {
		errors.push({ path: 'info', message: 'Missing "info" object' });
	} else {
		if (typeof doc.info.title !== 'string') {
			errors.push({ path: 'info.title', message: 'Missing "info.title" string' });
		}
		if (typeof doc.info.version !== 'string') {
			errors.push({ path: 'info.version', message: 'Missing "info.version" string' });
		}
	}

	if (!Array.isArray(doc.methods)) {
		errors.push({ path: 'methods', message: 'Missing "methods" array' });
		return errors;
	}

	// Collect known schema names for $ref resolution
	const knownSchemas = new Set<string>(
		Object.keys(doc.components?.schemas || {})
	);

	// Scan entire document for $ref pointers and nullable fields
	const docStr = JSON.stringify(doc);
	if (docStr.includes('"nullable"')) {
		errors.push({
			path: '',
			message: 'Document contains "nullable" field — use oneOf with { type: "null" } instead',
		});
	}

	// Validate each method
	for (let i = 0; i < doc.methods.length; i++) {
		const method = doc.methods[i];
		const mp = `methods[${i}]`;

		if (typeof method.name !== 'string') {
			errors.push({ path: `${mp}.name`, message: 'Missing method name' });
			continue;
		}

		const mpath = `methods["${method.name}"]`;

		// Namespace-qualified check
		if (!method.name.includes('.')) {
			errors.push({ path: `${mpath}.name`, message: `Method name "${method.name}" is not namespace-qualified (expected "namespace.method")` });
		}

		// Params
		if (!Array.isArray(method.params)) {
			errors.push({ path: `${mpath}.params`, message: 'Missing "params" array' });
		} else {
			for (let j = 0; j < method.params.length; j++) {
				const param = method.params[j];
				const pp = `${mpath}.params[${j}]`;
				if (typeof param.name !== 'string') {
					errors.push({ path: pp, message: 'Missing param name' });
				}
				if (typeof param.required !== 'boolean') {
					errors.push({ path: `${pp}.required`, message: 'Missing or non-boolean "required"' });
				}
				if (!param.schema || typeof param.schema !== 'object') {
					errors.push({ path: `${pp}.schema`, message: 'Missing param schema' });
				}
				// Check $ref resolution
				if (param.schema?.$ref) {
					validateRef(param.schema.$ref, `${pp}.schema.$ref`, knownSchemas, errors);
				}
			}
		}

		// Result
		if (!method.result || typeof method.result !== 'object') {
			errors.push({ path: `${mpath}.result`, message: 'Missing "result" object' });
		} else {
			if (typeof method.result.name !== 'string') {
				errors.push({ path: `${mpath}.result.name`, message: 'Missing result name' });
			} else if (method.result.name === 'result') {
				errors.push({ path: `${mpath}.result.name`, message: 'Result name should be descriptive, not "result"' });
			}
			if (!method.result.schema || typeof method.result.schema !== 'object') {
				errors.push({ path: `${mpath}.result.schema`, message: 'Missing result schema' });
			}
			// Check $ref resolution
			if (method.result.schema?.$ref) {
				validateRef(method.result.schema.$ref, `${mpath}.result.schema.$ref`, knownSchemas, errors);
			}
			// Check oneOf members for $refs
			if (Array.isArray(method.result.schema?.oneOf)) {
				for (let k = 0; k < method.result.schema.oneOf.length; k++) {
					const member = method.result.schema.oneOf[k];
					if (member.$ref) {
						validateRef(member.$ref, `${mpath}.result.schema.oneOf[${k}].$ref`, knownSchemas, errors);
					}
				}
			}

			// Validate x-blocks-transferable extension field
			if ('x-blocks-transferable' in (method.result.schema ?? {})) {
				const blocksTag = method.result.schema['x-blocks-transferable'];
				if (typeof blocksTag !== 'string' || blocksTag.length === 0) {
					errors.push({
						path: `${mpath}.result.schema.x-blocks-transferable`,
						message: 'x-blocks-transferable must be a non-empty string',
					});
				}
			}

			// Validate x-blocks-type-args extension field
			if ('x-blocks-type-args' in (method.result.schema ?? {})) {
				const typeArgs = method.result.schema['x-blocks-type-args'];
				if (!Array.isArray(typeArgs)) {
					errors.push({
						path: `${mpath}.result.schema.x-blocks-type-args`,
						message: 'x-blocks-type-args must be an array of JSON Schema objects',
					});
				} else {
					for (let k = 0; k < typeArgs.length; k++) {
						const arg = typeArgs[k];
						if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
							errors.push({
								path: `${mpath}.result.schema.x-blocks-type-args[${k}]`,
								message: 'Each entry in x-blocks-type-args must be a valid JSON Schema object',
							});
						} else if (arg.$ref) {
							validateRef(arg.$ref, `${mpath}.result.schema.x-blocks-type-args[${k}].$ref`, knownSchemas, errors);
						}
					}
				}
			}
		}
	}

	// Validate components.schemas entries are well-formed
	if (doc.components?.schemas) {
		for (const [name, schema] of Object.entries(doc.components.schemas)) {
			if (!schema || typeof schema !== 'object') {
				errors.push({ path: `components.schemas.${name}`, message: 'Schema must be an object' });
			}
		}
	}

	return errors;
}

function validateRef(
	ref: string,
	path: string,
	knownSchemas: Set<string>,
	errors: SpecValidationError[],
): void {
	const prefix = '#/components/schemas/';
	if (!ref.startsWith(prefix)) {
		errors.push({ path, message: `$ref "${ref}" must start with "${prefix}"` });
		return;
	}
	const schemaName = ref.slice(prefix.length);
	if (!knownSchemas.has(schemaName)) {
		errors.push({ path, message: `$ref "${ref}" does not resolve — "${schemaName}" not found in components.schemas` });
	}
}
