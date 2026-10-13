import type {
	LauncherFieldDefinition,
	LauncherFieldOptionDefinition,
} from "@leitwerk-dev/protocol/launcher-contract";

type Values = Record<string, string | boolean>;
type Options = Record<string, readonly LauncherFieldOptionDefinition[]>;

interface SelectionOverride {
	initialValue?: string;
	included: string[];
	excluded: string[];
	/** Retain known membership if a selected preset becomes unavailable. */
	members: Record<string, readonly string[]>;
}

export type LauncherSelections = Record<string, SelectionOverride>;

export const selectionValues = (value: unknown): string[] =>
	typeof value === "string" ? [...new Set(value.split("\n").filter(Boolean))] : [];

export function initializeLauncherSelections(
	fields: readonly LauncherFieldDefinition[],
	input: Record<string, unknown>,
): LauncherSelections {
	return Object.fromEntries(
		fields
			.filter((field) => field.multiple && field.presetsFrom)
			.map((field) => [
				field.id,
				{
					initialValue: typeof input[field.id] === "string" ? input[field.id] : undefined,
					included: [],
					excluded: [],
					members: {},
				},
			]),
	);
}

export function reconcileLauncherSelections(
	fields: readonly LauncherFieldDefinition[],
	values: Values,
	options: Options,
	selections: LauncherSelections,
): { values: Values; selections: LauncherSelections } {
	const nextValues = { ...values };
	const nextSelections = { ...selections };
	for (const field of fields) {
		if (!field.presetsFrom || !field.multiple) continue;
		const presetOptions =
			options[field.presetsFrom] ??
			fields.find((source) => source.id === field.presetsFrom)?.options;
		if (!presetOptions) continue;
		const previous = selections[field.id];
		if (!previous) continue;
		const members = { ...previous.members };
		for (const option of presetOptions) members[option.value] = option.selectionValues ?? [];
		const preset = new Set(
			selectionValues(values[field.presetsFrom]).flatMap((id) => members[id] ?? []),
		);
		const initial =
			previous.initialValue === undefined ? null : selectionValues(previous.initialValue);
		const included = initial ? initial.filter((id) => !preset.has(id)) : previous.included;
		const excluded = initial
			? [...preset].filter((id) => !initial.includes(id))
			: previous.excluded;
		nextValues[field.id] = [...new Set([...preset, ...included])]
			.filter((id) => !excluded.includes(id))
			.join("\n");
		nextSelections[field.id] = { included, excluded, members };
	}
	return { values: nextValues, selections: nextSelections };
}

export function changeLauncherSelection(
	fields: readonly LauncherFieldDefinition[],
	values: Values,
	options: Options,
	selections: LauncherSelections,
	fieldId: string,
	value: string | boolean,
): { values: Values; selections: LauncherSelections; resetFields: string[] } {
	const nextValues = { ...values, [fieldId]: value };
	const nextSelections = { ...selections };
	const previous = selections[fieldId];
	if (previous) {
		const before = selectionValues(values[fieldId]);
		const after = selectionValues(value);
		const added = after.filter((id) => !before.includes(id));
		const removed = before.filter((id) => !after.includes(id));
		nextSelections[fieldId] = {
			...previous,
			...(previous.initialValue === undefined ? {} : { initialValue: String(value) }),
			included: [...new Set([...previous.included, ...added])].filter(
				(id) => !removed.includes(id),
			),
			excluded: [...new Set([...previous.excluded, ...removed])].filter(
				(id) => !added.includes(id),
			),
		};
	}
	const changed = new Set(values[fieldId] === value ? [] : [fieldId]);
	const resetFields: string[] = [];
	for (let size = -1; size !== changed.size; ) {
		size = changed.size;
		for (const field of fields) {
			if (changed.has(field.id) || !field.resetOn?.some((id) => changed.has(id))) continue;
			changed.add(field.id);
			resetFields.push(field.id);
			nextValues[field.id] = field.kind === "boolean" ? false : "";
			if (nextSelections[field.id])
				nextSelections[field.id] = { included: [], excluded: [], members: {} };
		}
	}
	const nextOptions = Object.fromEntries(
		Object.entries(options).filter(([id]) => !resetFields.includes(id)),
	);
	return {
		...reconcileLauncherSelections(fields, nextValues, nextOptions, nextSelections),
		resetFields,
	};
}
