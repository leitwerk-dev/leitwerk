import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parseDocument } from "yaml";
import {
	type ApiItem,
	type ApiPackage,
	type ApiSurface,
	sourceFiles,
	unalias,
} from "./api-surface.js";

export interface UsageInput {
	files: string[];
	virtual: Map<string, string>;
	origins: Map<string, { file: string; line: number }>;
	composition: Array<{ file: string; entry: string }>;
}

/** Read working files, including uncommitted sources. Never execute consumer code. */
export function usageInput(roots: string[]): UsageInput {
	const files: string[] = [];
	const virtual = new Map<string, string>();
	const origins = new Map<string, { file: string; line: number }>();
	const composition: UsageInput["composition"] = [];
	for (const root of roots)
		for (const file of sourceFiles(root)) {
			if (/\.[cm]?[jt]sx?$/.test(file)) files.push(file);
			else if (!/\.sh$/.test(file) && !/composition.*\.ya?ml$/.test(file)) continue;
			const text = readFileSync(file, "utf8");
			if (/composition.*\.ya?ml$/.test(file)) {
				const document = parseDocument(text).toJS();
				for (const entry of document?.extensions ?? [])
					if (typeof entry === "string" && entry.startsWith("@")) composition.push({ file, entry });
				continue;
			}
			let index = 0;
			const embedded = (code: string, offset: number) => {
				if (!/(?:\bfrom\s*|\bimport\s*\(?|\brequire\s*\()\s*["']@leitwerk-dev\//.test(code)) return;
				const name = `${file}.embedded-${index++}.mts`;
				virtual.set(name, code);
				origins.set(name, { file, line: text.slice(0, offset).split("\n").length });
			};
			if (/\.sh$/.test(file)) {
				for (const match of text.matchAll(/'([^']*)'/gs)) embedded(match[1], match.index);
				for (const match of text.matchAll(/<<-?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\b/g))
					embedded(match[2], match.index + match[0].indexOf("\n") + 1);
			} else {
				const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
				const visit = (node: ts.Node) => {
					if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
						embedded(node.text, node.getStart());
					if (ts.isTemplateExpression(node))
						embedded(
							node.head.text +
								node.templateSpans.map((span) => `undefined${span.literal.text}`).join(""),
							node.getStart(),
						);
					ts.forEachChild(node, visit);
				};
				visit(source);
			}
		}
	return { files, virtual, origins, composition };
}

export interface UsageEvidence {
	consumer: string;
	file: string;
	line: number;
	kind: string;
}

export interface UsageResult {
	used: Map<ApiItem, UsageEvidence[]>;
	diagnostics: Array<UsageEvidence & { message: string }>;
	imports: string[];
}

/** Resolve member usage by declaration identity, never by a matching method name. */
export function consumerUsage(
	surface: ApiSurface,
	roots: string[],
	input: UsageInput,
	packages: ApiPackage[],
): UsageResult {
	const { checker, byNode } = surface;
	const sources = new Map(
		[...input.files, ...input.virtual.keys()].flatMap((file) => {
			const source = surface.program.getSourceFile(file);
			return source ? [[file, source] as const] : [];
		}),
	);
	const dependencies = new Map<string, string[]>();
	const reachable = new Set<string>();
	for (const [file, source] of sources) {
		const imports = ts
			.preProcessFile(source.text, true, true)
			.importedFiles.map((entry) => entry.fileName);
		if (imports.some((entry) => entry.startsWith("@leitwerk-dev/"))) reachable.add(file);
		dependencies.set(
			file,
			imports.flatMap((entry) => {
				const resolved = ts.resolveModuleName(
					entry,
					file,
					surface.program.getCompilerOptions(),
					ts.sys,
				).resolvedModule;
				return resolved ? [resolved.resolvedFileName] : [];
			}),
		);
	}
	for (let changed = true; changed; ) {
		changed = false;
		for (const [file, imports] of dependencies)
			if (!reachable.has(file) && imports.some((entry) => reachable.has(entry))) {
				reachable.add(file);
				changed = true;
			}
	}
	const used = new Map<ApiItem, UsageEvidence[]>();
	const diagnostics: UsageResult["diagnostics"] = [];
	const imports = new Set<string>();
	const usedFiles = new Set<string>();
	const location = (file: string, line: number, kind: string): UsageEvidence => {
		const origin = input.origins.get(file);
		const actual = origin?.file ?? file;
		const root = roots.find((r) => actual.startsWith(`${r}${path.sep}`)) as string;
		return {
			consumer: path.basename(root),
			file: path.relative(root, actual).replace(/\\/g, "/"),
			line: line + (origin ? origin.line - 1 : 0),
			kind: origin ? `embedded ${kind}` : kind,
		};
	};
	const markItem = (item: ApiItem, evidence: UsageEvidence) => {
		usedFiles.add(`${evidence.consumer}/${evidence.file}`);
		const existing = used.get(item) ?? [];
		if (
			!existing.some(
				(e) =>
					e.consumer === evidence.consumer && e.file === evidence.file && e.kind === evidence.kind,
			)
		)
			existing.push(evidence);
		used.set(item, existing);
	};
	const mark = (symbol: ts.Symbol | undefined, evidence: UsageEvidence) => {
		if (!symbol) return;
		for (const declaration of unalias(checker, symbol).declarations ?? []) {
			const item = byNode.get(declaration);
			if (item) markItem(item, evidence);
		}
	};
	const property = (type: ts.Type | undefined, key: string, evidence: UsageEvidence) => {
		if (!type) return;
		mark(type.getProperty(key), evidence);
		if (type.isUnionOrIntersection()) for (const part of type.types) property(part, key, evidence);
	};
	for (const file of [...input.files, ...input.virtual.keys()]) {
		const source = surface.program.getSourceFile(file);
		// Structural type interning may share a synthetic property symbol between
		// unrelated JavaScript objects. Require a real dependency path to the SDK.
		if (!source || !reachable.has(file)) continue;
		const evidenceAt = (node: ts.Node, kind: string) =>
			location(file, source.getLineAndCharacterOfPosition(node.getStart()).line + 1, kind);
		const visit = (node: ts.Node) => {
			if (ts.isIdentifier(node))
				mark(checker.getSymbolAtLocation(node), evidenceAt(node, "reference"));
			if (ts.isImportSpecifier(node)) {
				const declaration = node.parent.parent.parent;
				if (
					ts.isImportDeclaration(declaration) &&
					ts.isStringLiteral(declaration.moduleSpecifier)
				) {
					const entry = declaration.moduleSpecifier.text;
					const key = (node.propertyName ?? node.name).text;
					if (packages.some((p) => p.entries.has(entry)) && !surface.exports.has(`${entry}#${key}`))
						diagnostics.push({
							...evidenceAt(node, "unresolved import"),
							message: `${entry}#${key} is absent from this checkout`,
						});
				}
			}
			if (
				ts.isStringLiteralLike(node) &&
				packages.some((p) => node.text === p.name || node.text.startsWith(`${p.name}/`))
			) {
				const parent = node.parent;
				if (
					ts.isImportDeclaration(parent) ||
					ts.isExportDeclaration(parent) ||
					ts.isCallExpression(parent) ||
					(ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent))
				) {
					imports.add(node.text);
					if (!packages.some((p) => p.entries.has(node.text)))
						diagnostics.push({
							...evidenceAt(node, "unresolved import"),
							message: `Entry point ${node.text} is absent from this checkout`,
						});
				}
			}
			if (
				ts.isElementAccessExpression(node) &&
				node.argumentExpression &&
				ts.isStringLiteralLike(node.argumentExpression)
			)
				property(
					checker.getTypeAtLocation(node.expression),
					node.argumentExpression.text,
					evidenceAt(node, "indexed member"),
				);
			if (ts.isIndexedAccessTypeNode(node)) {
				const index = checker.getTypeFromTypeNode(node.indexType);
				for (const key of index.isUnion() ? index.types : [index])
					if (key.isStringLiteral())
						property(
							checker.getTypeFromTypeNode(node.objectType),
							key.value,
							evidenceAt(node, "indexed type"),
						);
			}
			if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
				property(
					checker.getTypeAtLocation(node.parent),
					(node.propertyName ?? node.name).getText().replace(/^["']|["']$/g, ""),
					evidenceAt(node, "destructured member"),
				);
			}
			if (ts.isObjectLiteralExpression(node)) {
				const contextual = checker.getContextualType(node);
				for (const member of node.properties) {
					if (member.name)
						property(
							contextual,
							member.name.getText().replace(/^["']|["']$/g, ""),
							evidenceAt(member, "supplied contract"),
						);
					// Forwarding an existing SDK object does not consume all its optional
					// members. Count concrete fields supplied by the consumer instead.
					if (ts.isSpreadAssignment(member))
						for (const key of checker.getTypeAtLocation(member.expression).getProperties())
							if (!key.declarations?.some((d) => byNode.has(d)))
								property(contextual, key.name, evidenceAt(member, "supplied spread"));
				}
			}
			if (ts.isClassDeclaration(node))
				for (const clause of node.heritageClauses ?? [])
					for (const base of clause.types) {
						const type = checker.getTypeAtLocation(base);
						for (const member of node.members)
							if (member.name)
								property(type, member.name.getText(), evidenceAt(member, "implemented contract"));
					}
			if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
				const declaration = checker.getResolvedSignature(node)?.getDeclaration();
				const item = declaration && byNode.get(declaration);
				if (item)
					markItem(item, evidenceAt(node, ts.isNewExpression(node) ? "construction" : "call"));
				for (const argument of node.arguments ?? []) {
					const contextual = checker.getContextualType(argument);
					if (!contextual) continue;
					for (const member of checker.getTypeAtLocation(argument).getProperties()) {
						if (member.declarations?.some((d) => sources.has(d.getSourceFile().fileName)))
							property(contextual, member.name, evidenceAt(argument, "supplied value"));
					}
				}
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
		// Unresolved members/imports must not masquerade as evidence of no use.
		const sourceLocation = location(file, 1, "source");
		const relevant =
			source.text.includes("@leitwerk-dev/") ||
			usedFiles.has(`${sourceLocation.consumer}/${sourceLocation.file}`);
		for (const diagnostic of relevant ? surface.program.getSemanticDiagnostics(source) : []) {
			if (![2305, 2307, 2339, 2459, 2551, 2614, 2694, 2724, 7016].includes(diagnostic.code))
				continue;
			diagnostics.push({
				...location(
					file,
					source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
					"unresolved reference",
				),
				message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
			});
		}
	}
	for (const { file, entry } of input.composition) {
		const targets = surface.exports.get(`${entry}#default`);
		if (targets)
			for (const item of targets) markItem(item, location(file, 1, "composition loading"));
		else if (packages.some((p) => p.name === entry))
			diagnostics.push({
				...location(file, 1, "unresolved composition"),
				message: `${entry} has no default extension entry point`,
			});
	}
	return { used, diagnostics, imports: [...imports].sort() };
}

/** Promote only named supporting types and enclosing declarations, not sibling members. */
export function supportedClosure(used: Map<ApiItem, UsageEvidence[]>): Map<ApiItem, string[]> {
	const support = new Map<ApiItem, string[]>(
		[...used.keys()].map((item) => [item, ["consumer usage"]]),
	);
	const pending = [...support.keys()];
	for (let i = 0; i < pending.length; i++) {
		const item = pending[i];
		for (const dependency of [...item.dependencies, ...(item.parent ? [item.parent] : [])]) {
			if (!support.has(dependency)) {
				support.set(dependency, [`signature or owner of ${item.id}`]);
				pending.push(dependency);
			}
		}
	}
	return support;
}
