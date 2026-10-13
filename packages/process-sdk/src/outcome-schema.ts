import { isUnknownRecord, normalizeStringArray } from "@leitwerk-dev/domain";
import type {
	OutcomeToolArrayItemSpec,
	OutcomeToolParameterSpec,
	OutcomeToolSpec,
} from "./types.js";

/** A structural error relative to the submitted tool arguments. @public */
export interface OutcomeSchemaIssue {
	/** @public */
	path: string;
	/** @public */
	code: string;
	/** @public */
	message: string;
}

/** Convert the parameter DSL to a native JSON Schema value declaration. @internal */
export function outcomeParameterSchema(spec: OutcomeToolParameterSpec): OutcomeToolArrayItemSpec {
	const {
		required,
		requiredProperties,
		requiredErrorCode,
		invalidErrorCode,
		minItemsErrorCode,
		minimumErrorCode,
		...value
	} = spec;
	return {
		...value,
		...(spec.type === "array" ? { items: spec.items ?? { type: "string" } } : {}),
		...(requiredProperties ? { required: requiredProperties } : {}),
		...(spec.type === "string" && required ? { minLength: Math.max(1, spec.minLength ?? 0) } : {}),
	};
}

/** Compile and check a model-facing object schema. @public */
export function compileOutcomeParameters(
	parameters: Record<string, OutcomeToolParameterSpec>,
	strict = false,
): OutcomeToolArrayItemSpec {
	const schema: OutcomeToolArrayItemSpec = {
		type: "object",
		properties: Object.fromEntries(
			Object.entries(parameters).map(([name, spec]) => [name, outcomeParameterSchema(spec)]),
		),
		required: Object.keys(parameters).filter((name) => parameters[name].required),
		additionalProperties: false,
	};
	assertOutcomeSchema(schema, strict);
	return schema;
}

/** Reject malformed declarations before a tool is exposed to the model. @public */
export function assertOutcomeSchema(
	schema: OutcomeToolArrayItemSpec,
	strict = false,
	path = "arguments",
): void {
	const fail = (message: string): never => {
		throw new Error(`${path}: ${message}`);
	};
	if (!isUnknownRecord(schema)) fail("expected a schema object");
	if (schema.anyOf !== undefined) {
		if (schema.type !== undefined || !Array.isArray(schema.anyOf) || !schema.anyOf.length)
			fail("anyOf needs at least one variant and cannot also declare type");
		if (
			schema.properties ||
			schema.items ||
			schema.required ||
			schema.enum ||
			schema.minimum !== undefined ||
			schema.minLength !== undefined ||
			schema.minItems !== undefined ||
			schema.additionalProperties !== undefined
		)
			fail("put value constraints inside the anyOf variants");
		schema.anyOf.forEach((variant, index) => {
			assertOutcomeSchema(variant, strict, `${path}.anyOf[${index}]`);
		});
		return;
	}
	if (!["string", "number", "boolean", "object", "array"].includes(schema.type ?? ""))
		fail("unsupported or missing type");
	for (const [key, type] of [
		["minLength", "string"],
		["minimum", "number"],
		["minItems", "array"],
	] as const) {
		const value = schema[key];
		if (
			value !== undefined &&
			(schema.type !== type ||
				!Number.isFinite(value) ||
				(key !== "minimum" && (!Number.isInteger(value) || value < 0)))
		)
			fail(`invalid ${key} for ${schema.type}`);
	}
	if (
		schema.enum !== undefined &&
		(schema.type !== "string" ||
			!Array.isArray(schema.enum) ||
			!schema.enum.length ||
			schema.enum.some((value) => typeof value !== "string"))
	)
		fail("enum must contain strings on a string schema");
	if (schema.type === "array") {
		if (!schema.items) fail("array must declare items");
		assertOutcomeSchema(schema.items!, strict, `${path}[]`);
	} else if (schema.items !== undefined) fail("items requires an array");
	if (schema.type === "object") {
		const properties = schema.properties ?? {};
		if (!isUnknownRecord(properties)) fail("properties must be an object");
		if (
			schema.required !== undefined &&
			(!Array.isArray(schema.required) ||
				schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key)))
		)
			fail("required must name declared properties");
		if (
			schema.additionalProperties !== undefined &&
			typeof schema.additionalProperties !== "boolean"
		)
			fail("additionalProperties must be boolean");
		if (
			strict &&
			(schema.additionalProperties !== false ||
				Object.keys(properties).some((key) => !schema.required?.includes(key)))
		)
			fail("strict schemas require every property and additionalProperties: false");
		for (const [key, value] of Object.entries(properties))
			assertOutcomeSchema(value, strict, `${path}.${key}`);
	} else if (
		schema.properties !== undefined ||
		schema.required !== undefined ||
		schema.additionalProperties !== undefined
	)
		fail("object keywords require an object");
}

/** Validate native schema values, retaining errors from an identifiable union branch. @public */
export function validateOutcomeValue(
	schema: OutcomeToolArrayItemSpec,
	value: unknown,
	path = "arguments",
): OutcomeSchemaIssue[] {
	const error = (code: string, message: string): OutcomeSchemaIssue[] => [
		{ path, code, message: `${path}: ${message}` },
	];
	if (schema.anyOf) {
		const branches = schema.anyOf.map((variant) => validateOutcomeValue(variant, value, path));
		if (branches.some((errors) => !errors.length)) return [];
		// Single-value string enums form an unambiguous discriminator. Generic anyOf
		// still accepts any matching branch, including overlapping alternatives.
		if (isUnknownRecord(value) && schema.anyOf.every((variant) => variant.type === "object")) {
			for (const key of Object.keys(schema.anyOf[0]?.properties ?? {})) {
				const tags = schema.anyOf.map((variant) =>
					variant.required?.includes(key) &&
					variant.properties?.[key]?.type === "string" &&
					variant.properties[key].enum?.length === 1
						? variant.properties[key].enum![0]
						: undefined,
				);
				if (tags.some((tag) => tag === undefined) || new Set(tags).size !== tags.length) continue;
				const selected = tags.indexOf(value[key] as string);
				if (selected >= 0) return branches[selected];
				return [
					{
						path: `${path}.${key}`,
						code: "enum",
						message: `${path}.${key}: choose ${tags.join(", ")}`,
					},
				];
			}
		}
		return error(
			"anyOf",
			`must match an alternative (${branches.map((errors) => errors.map((issue) => issue.message).join("; ")).join(" | ")})`,
		);
	}
	if (schema.type === "object") {
		if (!isUnknownRecord(value)) return error("type", "expected an object");
		const properties = schema.properties ?? {};
		return [
			...Object.keys(value)
				.filter((key) => schema.additionalProperties === false && !Object.hasOwn(properties, key))
				.map((key) => ({
					path: `${path}.${key}`,
					code: "unknown_parameter",
					message: `${path}.${key}: unsupported field; allowed fields: ${Object.keys(properties).join(", ")}`,
				})),
			...(schema.required ?? [])
				.filter((key) => !Object.hasOwn(value, key) || value[key] === undefined)
				.map((key) => ({
					path: `${path}.${key}`,
					code: "required",
					message: `${path}.${key}: required`,
				})),
			...Object.entries(properties).flatMap(([key, spec]) =>
				value[key] === undefined ? [] : validateOutcomeValue(spec, value[key], `${path}.${key}`),
			),
		];
	}
	if (schema.type === "array") {
		if (!Array.isArray(value)) return error("type", "expected an array");
		return [
			...(value.length < (schema.minItems ?? 0)
				? error("minItems", `requires at least ${schema.minItems} item(s)`)
				: []),
			...value.flatMap((item, index) =>
				schema.items ? validateOutcomeValue(schema.items, item, `${path}[${index}]`) : [],
			),
		];
	}
	if (typeof value !== schema.type || (typeof value === "number" && !Number.isFinite(value)))
		return error("type", `expected ${schema.type === "number" ? "a finite number" : schema.type}`);
	if (typeof value === "string") {
		if (schema.enum && !schema.enum.includes(value))
			return error("enum", `choose ${schema.enum.join(", ")}`);
		if (value.length < (schema.minLength ?? 0))
			return error("minLength", `requires at least ${schema.minLength} characters`);
	}
	if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum)
		return error("minimum", `must be >= ${schema.minimum}`);
	return [];
}

function snakeCase(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^a-zA-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

/** Validate the parameter DSL with its established server error codes. @public */
export function validateOutcomeParameters(
	parameters: Record<string, OutcomeToolParameterSpec>,
	value: unknown,
): OutcomeSchemaIssue[] {
	if (!isUnknownRecord(value))
		return [{ path: "arguments", code: "invalid_params", message: "params must be an object" }];
	const issues: OutcomeSchemaIssue[] = Object.keys(value)
		.filter((key) => !Object.hasOwn(parameters, key))
		.map((key) => ({ path: key, code: "unknown_parameter", message: `${key}: unknown parameter` }));
	for (const [key, spec] of Object.entries(parameters)) {
		const item = value[key];
		const requiredCode = spec.requiredErrorCode ?? `${snakeCase(key)}_required`;
		if (
			item === undefined ||
			(spec.type === "string" && typeof item === "string" && !item.trim() && spec.required)
		) {
			if (spec.required)
				issues.push({
					path: key,
					code: requiredCode,
					message: `${key}: required and must be non-empty`,
				});
			continue;
		}
		const errors = validateOutcomeValue(outcomeParameterSchema(spec), item, key);
		if (
			spec.type === "array" &&
			Array.isArray(item) &&
			(spec.items === undefined || spec.items.type === "string") &&
			spec.minItems !== undefined &&
			normalizeStringArray(item).length < spec.minItems &&
			!errors.some((issue) => issue.code === "minItems")
		)
			errors.push({
				path: key,
				code: "minItems",
				message: `${key}: requires at least ${spec.minItems} nonempty item(s)`,
			});
		issues.push(
			...errors.map((issue) => ({
				...issue,
				code:
					issue.path === key && issue.code === "minItems"
						? (spec.minItemsErrorCode ?? requiredCode)
						: issue.path === key && issue.code === "minimum"
							? (spec.minimumErrorCode ?? spec.invalidErrorCode ?? `invalid_${snakeCase(key)}`)
							: (spec.invalidErrorCode ?? `invalid_${snakeCase(key)}`),
			})),
		);
	}
	return issues;
}

/** Include injected Markdown only for the model call, not terminal params. @internal */
export function outcomeCallParameters(
	spec: OutcomeToolSpec,
	markdownParameter?: string,
): Record<string, OutcomeToolParameterSpec> {
	if (!markdownParameter || spec.turnResultMarkdownParameter) return spec.parameters;
	return {
		...spec.parameters,
		...(!spec.strictSchema
			? {
					resultSummary: {
						type: "string" as const,
						description: "Concise result summary for this attempt.",
					},
				}
			: {}),
		[markdownParameter]: {
			type: "string",
			description:
				"Operator-facing Markdown result. Pass raw Markdown without wrapping it in a code fence.",
			required: true,
			requiredErrorCode: `${markdownParameter}_required`,
		},
	};
}
