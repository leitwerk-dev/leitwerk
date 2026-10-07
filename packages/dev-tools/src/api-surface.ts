import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { isInside, listWorkspacePackageDirs } from "./workspace.js";

/** The checker follows package exports, including source conditions and wildcard subpaths. */
export interface ApiPackage {
	name: string;
	dir: string;
	entries: Map<string, string>;
}

export function sourceFiles(root: string): string[] {
	const ignored = new Set([
		"node_modules",
		"dist",
		"build",
		"coverage",
		"vendor",
		"vendored",
		"docs",
		"test-results",
		"playwright-report",
		".git",
		".hg",
		".svn",
		".cache",
		".turbo",
		".svelte-kit",
		".leitwerk",
		".leitwerk-base",
		".leitwerk-upstream",
		".worktrees",
		".release",
	]);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.flatMap((entry) => {
			if (
				ignored.has(entry.name) ||
				entry.isSymbolicLink() ||
				/\.(?:min|umd)\.js$/.test(entry.name)
			)
				return [];
			const file = path.join(root, entry.name);
			if (entry.isDirectory() && existsSync(path.join(file, "package.json"))) {
				try {
					const manifest = JSON.parse(readFileSync(path.join(file, "package.json"), "utf8"));
					if (manifest.name === "leitwerk" && manifest.workspaces) return [];
				} catch {
					// Malformed package fixtures do not prevent source discovery.
				}
			}
			return entry.isDirectory() ? sourceFiles(file) : [file];
		})
		.sort();
}

function exportTarget(value: unknown, condition: "source" | "types"): string | undefined {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return;
	const conditions = value as Record<string, unknown>;
	for (const key of condition === "types"
		? ["types", "import", "default", "require"]
		: ["source", "types", "import", "default", "require"]) {
		const target = exportTarget(conditions[key], condition);
		if (target) return target;
	}
}

export function apiPackages(root: string, condition: "source" | "types" = "source"): ApiPackage[] {
	return [root, ...listWorkspacePackageDirs(root)].flatMap((dir) => {
		const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
		if (!manifest.name) return [];
		const exports = manifest.exports;
		const entries = new Map<string, string>();
		const paths =
			typeof exports === "object" && exports && Object.keys(exports).some((k) => k.startsWith("."))
				? exports
				: { ".": exports ?? manifest.types ?? manifest.main };
		for (const [subpath, value] of Object.entries(paths)) {
			const target = exportTarget(value, condition);
			if (!target) continue;
			const specifier = manifest.name + (subpath === "." ? "" : subpath.slice(1));
			if (target.includes("*")) {
				const [before, after] = path.resolve(dir, target).split("*");
				for (const file of sourceFiles(path.dirname(before))) {
					if (
						file.startsWith(before) &&
						file.endsWith(after) &&
						!/\.(test|integration\.test)\./.test(file)
					)
						entries.set(
							specifier.replace("*", file.slice(before.length, file.length - after.length)),
							file,
						);
				}
			} else if (/\.[cm]?[jt]sx?$/.test(target)) {
				entries.set(specifier, path.resolve(dir, target));
			}
		}
		return entries.size ? [{ name: manifest.name, dir, entries }] : [];
	});
}

export function apiProgram(
	packages: ApiPackage[],
	extraFiles: string[] = [],
	virtual = new Map<string, string>(),
): ts.Program {
	const paths = Object.fromEntries(
		packages.flatMap((pkg) => [...pkg.entries].map(([key, file]) => [key, [file]])),
	);
	const options: ts.CompilerOptions = {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		customConditions: ["source"],
		strict: true,
		skipLibCheck: true,
		allowJs: true,
		checkJs: true,
		noEmit: true,
		paths,
		types: ["node"],
	};
	const host = ts.createCompilerHost(options);
	const readFile = host.readFile.bind(host);
	const fileExists = host.fileExists.bind(host);
	host.readFile = (file) => virtual.get(file) ?? readFile(file);
	host.fileExists = (file) => virtual.has(file) || fileExists(file);
	return ts.createProgram({
		rootNames: [
			...new Set([
				...packages.flatMap((p) => [...p.entries.values()]),
				...extraFiles,
				...virtual.keys(),
			]),
		],
		options,
		host,
	});
}

export function unalias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
	return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function hidden(node: ts.Node): boolean {
	return (
		(ts.canHaveModifiers(node) &&
			ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) === true ||
		("name" in node && !!node.name && ts.isPrivateIdentifier(node.name as ts.Node))
	);
}

export function annotationNode(node: ts.Node): ts.Node {
	if (ts.isBindingElement(node)) {
		let parent: ts.Node = node.parent;
		while (!ts.isVariableDeclaration(parent) && parent.parent) parent = parent.parent;
		if (ts.isVariableDeclaration(parent)) return annotationNode(parent);
	}
	return ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)
		? node.parent.parent
		: node;
}

export function releaseTags(node: ts.Node): string[] {
	const nodes = [annotationNode(node)];
	if (ts.isExportSpecifier(node)) nodes.push(node.parent.parent);
	return nodes
		.flatMap((declaration) => ts.getJSDocTags(declaration))
		.map((tag) => tag.tagName.text)
		.filter((tag) => tag === "public" || tag === "internal");
}

function nodeName(node: ts.Node): string | undefined {
	if ("name" in node && node.name && typeof node.name === "object") {
		const name = node.name as ts.Node;
		if (!ts.isObjectBindingPattern(name) && !ts.isArrayBindingPattern(name)) return name.getText();
	}
	if (ts.isConstructorDeclaration(node) || ts.isConstructSignatureDeclaration(node))
		return "constructor";
	if (ts.isCallSignatureDeclaration(node)) return "call";
	if (ts.isIndexSignatureDeclaration(node)) return "index";
	if (ts.isExportAssignment(node)) return "default";
	if (ts.isReturnStatement(node)) return "return";
}

function qualifiedName(node: ts.Node): string {
	const parts: string[] = [];
	for (
		let current: ts.Node | undefined = node;
		current && !ts.isSourceFile(current);
		current = current.parent
	) {
		const name = nodeName(current);
		if (name) parts.unshift(name);
	}
	return parts.join(".") || "default";
}

export interface ApiItem {
	id: string;
	node: ts.Declaration;
	package: ApiPackage;
	name: string;
	tags: string[];
	dependencies: Set<ApiItem>;
	parent?: ApiItem;
	signature: string;
}

export interface ApiSurface {
	program: ts.Program;
	checker: ts.TypeChecker;
	items: ApiItem[];
	byNode: Map<ts.Node, ApiItem>;
	exports: Map<string, ApiItem[]>;
	diagnostics: string[];
}

/** Walk only the exposed type graph. Function bodies and private class state are not APIs. */
export function apiSurface(program: ts.Program, packages: ApiPackage[]): ApiSurface {
	const checker = program.getTypeChecker();
	const byNode = new Map<ts.Node, ApiItem>();
	const seenTypes = new Set<ts.Type>();
	const seenSymbols = new Set<ts.Symbol>();
	const seenContainers = new Set<ts.Symbol>();
	const exports = new Map<string, ApiItem[]>();
	const diagnostics: string[] = [];
	const ownershipOrder = [...packages].sort((a, b) => b.dir.length - a.dir.length);
	const owners = new Map<ts.SourceFile, ApiPackage | undefined>();
	const owner = (node: ts.Node) => {
		const source = node.getSourceFile();
		if (!owners.has(source))
			owners.set(
				source,
				ownershipOrder.find(
					(pkg) =>
						isInside(pkg.dir, source.fileName) &&
						!path.relative(pkg.dir, source.fileName).split(path.sep).includes("node_modules"),
				),
			);
		return owners.get(source);
	};
	function add(node: ts.Declaration): void {
		if (
			ts.isArrowFunction(node) ||
			ts.isFunctionExpression(node) ||
			ts.isClassExpression(node) ||
			ts.isTypeLiteralNode(node) ||
			ts.isObjectLiteralExpression(node)
		)
			return;
		if (byNode.has(node) || hidden(node)) return;
		const pkg = owner(node);
		if (!pkg) return;
		byNode.set(node, {
			id: "",
			node,
			package: pkg,
			name: qualifiedName(node),
			tags: releaseTags(node),
			dependencies: new Set(),
			signature: "",
		});
	}
	function symbol(raw: ts.Symbol): void {
		const value = unalias(checker, raw);
		if (value.flags & ts.SymbolFlags.TypeParameter) return;
		if (seenSymbols.has(value)) return;
		seenSymbols.add(value);
		const declarations = (value.declarations ?? []).filter((d) => owner(d) && !hidden(d));
		if (!declarations.length) return;
		for (const declaration of declarations) add(declaration);
		if (
			value.flags &
			(ts.SymbolFlags.Interface |
				ts.SymbolFlags.Class |
				ts.SymbolFlags.TypeAlias |
				ts.SymbolFlags.Enum)
		)
			type(checker.getDeclaredTypeOfSymbol(value));
		type(checker.getTypeOfSymbolAtLocation(value, declarations[0]));
	}
	function signature(value: ts.Signature): void {
		const declaration = value.getDeclaration();
		if (
			declaration &&
			!hidden(declaration) &&
			!ts.isFunctionExpression(declaration) &&
			!ts.isArrowFunction(declaration) &&
			!ts.isFunctionTypeNode(declaration)
		)
			add(declaration);
		for (const parameter of value.parameters)
			type(
				checker.getTypeOfSymbolAtLocation(
					parameter,
					declaration ?? parameter.valueDeclaration ?? (parameter.declarations?.[0] as ts.Node),
				),
			);
		for (const parameter of value.typeParameters ?? []) type(parameter);
		type(value.getReturnType());
	}
	function type(value: ts.Type | undefined): void {
		if (!value || seenTypes.has(value)) return;
		seenTypes.add(value);
		if (
			value.flags &
			(ts.TypeFlags.StringLike |
				ts.TypeFlags.NumberLike |
				ts.TypeFlags.BooleanLike |
				ts.TypeFlags.Any |
				ts.TypeFlags.Unknown |
				ts.TypeFlags.Never |
				ts.TypeFlags.Void |
				ts.TypeFlags.Undefined |
				ts.TypeFlags.Null)
		)
			return;
		if (value.aliasSymbol) symbol(value.aliasSymbol);
		for (const argument of value.aliasTypeArguments ?? []) type(argument);
		if (value.isUnionOrIntersection()) {
			for (const part of value.types) type(part);
			return;
		}
		if (value.flags & ts.TypeFlags.TypeParameter) {
			type(value.getConstraint());
			type(value.getDefault());
			return;
		}
		if (
			value.flags & ts.TypeFlags.Object &&
			(value as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
		) {
			const reference = value as ts.TypeReference;
			if (reference.target !== value) {
				type(reference.target);
				for (const argument of checker.getTypeArguments(reference)) type(argument);
				return;
			}
		}
		const sym = value.getSymbol();
		if (sym) {
			if (!sym.declarations?.some((d) => owner(d))) {
				// Mapped types (for example a schema library's inferred output) can
				// have a foreign container but retain our own field declarations.
				for (const property of value.getProperties()) {
					if (property.declarations?.some((d) => owner(d))) symbol(property);
				}
				return;
			}
			if (sym.flags & (ts.SymbolFlags.TypeLiteral | ts.SymbolFlags.ObjectLiteral)) {
				if (seenContainers.has(sym)) return;
				seenContainers.add(sym);
			}
			// __type and __object are containers, not declarations requiring a tag.
			if (!(sym.flags & (ts.SymbolFlags.TypeLiteral | ts.SymbolFlags.ObjectLiteral))) symbol(sym);
		}
		for (const property of value.getProperties()) symbol(property);
		for (const sig of [...value.getCallSignatures(), ...value.getConstructSignatures()])
			signature(sig);
		for (const info of checker.getIndexInfosOfType(value)) {
			if (info.declaration) add(info.declaration);
			type(info.type);
		}
	}
	for (const pkg of packages)
		for (const [entry, file] of pkg.entries) {
			const source = program.getSourceFile(file);
			const module = source && checker.getSymbolAtLocation(source);
			if (!module) {
				diagnostics.push(`${entry}: cannot resolve entry point ${path.relative(pkg.dir, file)}`);
				continue;
			}
			for (const exported of checker.getExportsOfModule(module)) {
				const resolved = unalias(checker, exported);
				symbol(resolved);
				if (resolved.valueDeclaration && ts.isExportAssignment(resolved.valueDeclaration))
					type(checker.getTypeAtLocation(resolved.valueDeclaration.expression));
				const targets = (resolved.declarations ?? []).flatMap((d) => byNode.get(d) ?? []);
				exports.set(`${entry}#${exported.name}`, targets);
				for (const declaration of exported.declarations ?? []) {
					const tags = releaseTags(declaration);
					if (
						tags.length &&
						targets.some((target) => target.tags.some((tag) => !tags.includes(tag)))
					)
						diagnostics.push(`${entry}#${exported.name}: conflicting re-export annotation`);
				}
			}
		}
	// Some supporting declarations disappear from the evaluated type, such as
	// the schema in InferOutput<typeof schema>. They still occur in the emitted
	// signature and need an explicit classification.
	for (const item of byNode.values()) {
		const references = (node: ts.Node): void => {
			const name = ts.isTypeReferenceNode(node)
				? node.typeName
				: ts.isTypeQueryNode(node)
					? node.exprName
					: ts.isExpressionWithTypeArguments(node)
						? node.expression
						: undefined;
			const target = name && checker.getSymbolAtLocation(name);
			if (target) symbol(target);
			ts.forEachChild(node, references);
		};
		const declaration = item.node;
		if ("type" in declaration && declaration.type) references(declaration.type as ts.Node);
		if ("parameters" in declaration)
			for (const parameter of (declaration as ts.SignatureDeclaration).parameters)
				if (parameter.type) references(parameter.type);
		if ("typeParameters" in declaration)
			for (const parameter of (declaration as ts.SignatureDeclaration).typeParameters ?? [])
				references(parameter);
		if (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration))
			for (const clause of declaration.heritageClauses ?? []) references(clause);
	}
	const items = [...byNode.values()].sort(
		(a, b) =>
			a.node.getSourceFile().fileName.localeCompare(b.node.getSourceFile().fileName) ||
			a.node.getStart() - b.node.getStart(),
	);
	const ids = new Map<string, number>();
	for (const item of items) {
		const base = `${item.package.name}/${path.relative(item.package.dir, item.node.getSourceFile().fileName).replace(/\\/g, "/")}#${item.name}`;
		const ordinal = (ids.get(base) ?? 0) + 1;
		ids.set(base, ordinal);
		item.id = base + (ordinal === 1 ? "" : `~${ordinal}`);
		for (let parent = item.node.parent; parent; parent = parent.parent)
			if (byNode.has(parent)) {
				item.parent = byNode.get(parent);
				break;
			}
		item.signature = itemSignature(checker, item.node);
	}
	// Named signature dependencies are checked separately from members: a supported
	// interface never implicitly promotes all of its methods.
	for (const item of items) {
		const visited = new Set<ts.Type>();
		const ref = (raw: ts.Symbol | undefined) => {
			if (!raw) return false;
			const targets = (unalias(checker, raw).declarations ?? []).flatMap(
				(d) => byNode.get(d) ?? [],
			);
			for (const target of targets) if (target !== item) item.dependencies.add(target);
			return targets.some((target) => target !== item);
		};
		const dependency = (value: ts.Type | undefined): void => {
			if (!value || visited.has(value)) return;
			visited.add(value);
			const named = ref(value.aliasSymbol) || ref(value.getSymbol());
			for (const arg of value.aliasTypeArguments ?? []) dependency(arg);
			if (
				value.flags & ts.TypeFlags.Object &&
				(value as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
			)
				for (const arg of checker.getTypeArguments(value as ts.TypeReference)) dependency(arg);
			if (named) return;
			if (value.isUnionOrIntersection()) for (const part of value.types) dependency(part);
			if (value.flags & ts.TypeFlags.TypeParameter) {
				dependency(value.getConstraint());
				dependency(value.getDefault());
			}
			for (const sig of value.getCallSignatures()) {
				for (const param of sig.parameters)
					dependency(checker.getTypeOfSymbolAtLocation(param, item.node));
				dependency(sig.getReturnType());
			}
		};
		const syntax = (node: ts.Node): void => {
			if (node !== item.node && byNode.has(node)) return;
			if (hidden(node)) return;
			if (ts.isTypeReferenceNode(node)) ref(checker.getSymbolAtLocation(node.typeName));
			if (ts.isTypeQueryNode(node)) ref(checker.getSymbolAtLocation(node.exprName));
			if (ts.isExpressionWithTypeArguments(node)) ref(checker.getSymbolAtLocation(node.expression));
			if (ts.isBlock(node) || ts.isObjectLiteralExpression(node)) return;
			ts.forEachChild(node, syntax);
		};
		syntax(item.node);
		if (
			ts.isFunctionDeclaration(item.node) ||
			ts.isMethodDeclaration(item.node) ||
			ts.isMethodSignature(item.node) ||
			ts.isCallSignatureDeclaration(item.node) ||
			ts.isConstructSignatureDeclaration(item.node) ||
			ts.isConstructorDeclaration(item.node) ||
			ts.isGetAccessorDeclaration(item.node) ||
			ts.isSetAccessorDeclaration(item.node)
		) {
			const sig = checker.getSignatureFromDeclaration(item.node);
			if (sig) {
				for (const p of sig.parameters) dependency(checker.getTypeOfSymbolAtLocation(p, item.node));
				dependency(sig.getReturnType());
			}
		} else if (!ts.isInterfaceDeclaration(item.node) && !ts.isClassDeclaration(item.node))
			dependency(checker.getTypeAtLocation(item.node));
	}
	return { program, checker, items, byNode, exports, diagnostics };
}

function itemSignature(checker: ts.TypeChecker, node: ts.Declaration): string {
	const printer = ts.createPrinter({ removeComments: true });
	const print = (n: ts.Node) =>
		printer.printNode(ts.EmitHint.Unspecified, n, node.getSourceFile()).replace(/\s+/g, " ").trim();
	const modifiers = ts.canHaveModifiers(node)
		? (ts.getModifiers(node) ?? [])
				.map(print)
				.filter((m) => !["export", "default", "declare", "async"].includes(m))
				.join(" ")
		: "";
	const prefix = modifiers ? `${modifiers} ` : "";
	if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
		return `${prefix}${ts.isInterfaceDeclaration(node) ? "interface" : "class"} ${node.name?.text ?? "default"}${node.typeParameters ? `<${node.typeParameters.map(print).join(", ")}>` : ""} ${(node.heritageClauses ?? []).map(print).join(" ")}`.trim();
	}
	if (ts.isTypeAliasDeclaration(node)) return print(node);
	const sig = ts.isFunctionLike(node) ? checker.getSignatureFromDeclaration(node) : undefined;
	if (sig)
		return `${prefix}${nodeName(node) ?? "call"}${"questionToken" in node && node.questionToken ? "?" : ""}${checker.signatureToString(sig, node, ts.TypeFormatFlags.NoTruncation)}`;
	const type = checker.getTypeAtLocation(node);
	const flags = ts.TypeFormatFlags.NoTruncation;
	return `${prefix}${nodeName(node) ?? "default"}${"questionToken" in node && node.questionToken ? "?" : ""}: ${checker.typeToString(type, node, flags)}`;
}
