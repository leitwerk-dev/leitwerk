import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { CompilerState, Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import { svelte2tsx } from "svelte2tsx";
import ts from "typescript";

const slash = (value) => value.split(path.sep).join("/");
const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 20);
/** @internal */
export const stableId = (...parts) => parts.map(encodeURIComponent).join("|");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
/** @internal */
export function walk(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name))
		.flatMap((item) => {
			if (
				[
					"node_modules",
					"dist",
					".git",
					".generated",
					"coverage",
					"build",
					".leitwerk",
					"tools",
				].includes(item.name)
			)
				return [];
			const file = path.join(dir, item.name);
			// Nested checkouts are separate consumers, not sources of this workspace.
			// Explicit source roots still allow a composition to select one.
			if (item.isDirectory() && fs.existsSync(path.join(file, ".git"))) return [];
			return item.isDirectory() ? walk(file) : item.isFile() ? [file] : [];
		});
}
function condition(value, key) {
	if (!value || typeof value !== "object") return undefined;
	if (typeof value[key] === "string") return value[key];
	for (const child of Object.values(value)) {
		const found = condition(child, key);
		if (found) return found;
	}
}
function filesIncludingDist(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
		const file = path.join(dir, item.name);
		return item.isDirectory() ? filesIncludingDist(file) : [file];
	});
}
/** @internal */
export function discover(root, packageDirs) {
	const packages = [],
		entries = [],
		diagnostics = [];
	const folders =
		packageDirs ??
		["packages", "extensions"].flatMap((group) => {
			const dir = path.join(root, group);
			return fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => path.join(dir, name)) : [];
		});
	for (const folder of folders) {
		const group = slash(path.relative(root, folder)).split("/")[0];
		const manifestPath = path.join(folder, "package.json");
		if (!fs.existsSync(manifestPath)) continue;
		const manifest = readJson(manifestPath);
		const pkg = {
			id: stableId("package", manifest.name),
			name: manifest.name,
			version: manifest.version ?? "unknown",
			label: manifest.name,
			kind: "package",
			package: manifest.name,
			group,
			path: slash(path.relative(root, folder)),
			source: {
				path: slash(path.relative(root, manifestPath)),
				line: 1,
				column: 1,
				snippetStart: 1,
				snippet: fs.readFileSync(manifestPath, "utf8").split("\n").slice(0, 7).join("\n"),
			},
		};
		packages.push(pkg);
		const exports = manifest.exports ?? (manifest.types ? { ".": { types: manifest.types } } : {});
		const records =
			typeof exports === "string" || !Object.keys(exports).some((k) => k.startsWith("."))
				? { ".": exports }
				: exports;
		for (const [subpath, value] of Object.entries(records)) {
			let types = condition(value, "types");
			const source = condition(value, "source");
			if (!types && typeof value === "string" && /\.[cm]?js$/.test(value))
				types = value.replace(/\.[cm]?js$/, ".d.ts");
			if (!types) {
				diagnostics.push({
					severity: "info",
					scope: manifest.name + subpath,
					message:
						"Export has no declaration target; skipped (assets and runtime-only exports are not APIs).",
				});
				continue;
			}
			let replacements = [""];
			if (types.includes("*")) {
				const [prefix, suffix] = types.split("*");
				const absolutePrefix =
					path.resolve(folder, prefix) + (prefix.endsWith("/") ? path.sep : "");
				const base = path.dirname(absolutePrefix);
				replacements = filesIncludingDist(base)
					.filter((f) => f.startsWith(absolutePrefix) && f.endsWith(suffix))
					.map((f) => f.slice(absolutePrefix.length, -suffix.length || undefined))
					.sort();
				if (!replacements.length)
					diagnostics.push({
						severity: "error",
						scope: manifest.name + subpath,
						message: `Wildcard declaration target matched no files: ${types}`,
					});
			}
			for (const replacement of replacements) {
				const entry = subpath.replaceAll("*", replacement);
				const declaration = path.resolve(folder, types.replaceAll("*", replacement));
				let src = source
					? path.resolve(folder, source.replaceAll("*", replacement))
					: declaration.replace("/dist/", "/src/").replace(/\.d\.([cm]?ts)$/, ".$1");
				if (!fs.existsSync(src)) src = fs.existsSync(declaration) ? declaration : undefined;
				entries.push({
					id: stableId("entry", manifest.name, entry),
					label: entry,
					kind: "entry",
					package: manifest.name,
					parentId: pkg.id,
					entry,
					folder,
					manifestPath,
					declaration,
					source: src,
				});
			}
		}
	}
	return { packages, entries, diagnostics };
}
function extractModels(root, entries, output, diagnostics) {
	fs.mkdirSync(output, { recursive: true });
	const configs = new Map();
	for (const entry of entries) {
		if (!fs.existsSync(entry.declaration)) {
			diagnostics.push({
				severity: "error",
				scope: entry.id,
				message: `Missing declaration: ${slash(path.relative(root, entry.declaration))}. Rebuild the repository.`,
			});
			continue;
		}
		const config = ExtractorConfig.prepare({
			configObject: {
				projectFolder: entry.folder,
				mainEntryPointFilePath: entry.declaration,
				compiler: {
					overrideTsconfig: {
						compilerOptions: {
							target: "ES2022",
							module: "NodeNext",
							moduleResolution: "NodeNext",
							skipLibCheck: true,
							strict: true,
							esModuleInterop: true,
						},
						files: [entry.declaration],
					},
				},
				apiReport: { enabled: false },
				dtsRollup: { enabled: false },
				tsdocMetadata: { enabled: false },
				docModel: {
					enabled: true,
					apiJsonFilePath: path.join(output, `${hash(entry.id)}.api.json`),
					releaseTagsToTrim: [],
				},
				messages: {
					compilerMessageReporting: { default: { logLevel: "warning" } },
					extractorMessageReporting: { default: { logLevel: "warning" } },
					tsdocMessageReporting: { default: { logLevel: "none" } },
				},
			},
			configObjectFullPath: undefined,
			packageJsonFullPath: entry.manifestPath,
		});
		configs.set(entry.id, config);
	}
	const first = configs.values().next().value;
	const state = first
		? CompilerState.create(first, {
				additionalEntryPoints: [...configs.values()].map((c) => c.mainEntryPointFilePath),
			})
		: undefined;
	const models = new Map();
	for (const entry of entries) {
		const config = configs.get(entry.id);
		if (!config) continue;
		try {
			const result = Extractor.invoke(config, {
				localBuild: true,
				compilerState: state,
				showVerboseMessages: false,
				messageCallback(message) {
					message.handled = true;
					if (["warning", "error"].includes(message.logLevel))
						diagnostics.push({
							severity: message.logLevel,
							scope: entry.id,
							message: `${message.messageId}: ${message.text}`,
						});
				},
			});
			if (fs.existsSync(config.apiJsonFilePath))
				models.set(entry.id, readJson(config.apiJsonFilePath));
			if (!result.succeeded)
				diagnostics.push({
					severity: "error",
					scope: entry.id,
					message: "API Extractor reported incomplete extraction.",
				});
		} catch (error) {
			diagnostics.push({ severity: "error", scope: entry.id, message: String(error) });
		}
	}
	return models;
}

/** @internal */
export async function createSnapshot(
	root,
	output,
	{ extract = true, packageDirs, sourceRoots } = {},
) {
	const { packages, entries, diagnostics } = discover(root, packageDirs);
	const models = extract
		? extractModels(root, entries, path.join(output, "models"), diagnostics)
		: new Map();
	const allFiles = [
		...new Set(
			(
				sourceRoots ??
				["packages", "extensions", "tests", "scripts", "sandbox"].map((dir) => path.join(root, dir))
			).flatMap((dir) => walk(dir)),
		),
	].filter((f) => /\.[cm]?[jt]sx?$|\.svelte$/.test(f) && !/\.d\.[cm]?ts$/.test(f));
	const virtual = new Map();
	const sourceFiles = allFiles.map((file) => {
		if (!file.endsWith(".svelte")) return file;
		try {
			const original = fs.readFileSync(file, "utf8");
			const result = svelte2tsx(original, { filename: file, isTsFile: true });
			virtual.set(`${file}.tsx`, {
				code: result.code,
				map: new TraceMap(result.map),
				original,
				file,
			});
			return `${file}.tsx`;
		} catch (error) {
			diagnostics.push({
				severity: "error",
				scope: slash(path.relative(root, file)),
				message: `Svelte analysis failed: ${error.message}`,
			});
			return file;
		}
	});
	const paths = Object.fromEntries(
		entries
			.filter((e) => e.source)
			.map((e) => [e.package + (e.entry === "." ? "" : e.entry.slice(1)), [e.source]]),
	);
	const options = {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		paths,
		customConditions: ["source"],
		allowJs: true,
		checkJs: false,
		skipLibCheck: true,
		esModuleInterop: true,
		jsx: ts.JsxEmit.Preserve,
		noEmit: true,
	};
	const host = ts.createCompilerHost(options);
	const readFile = host.readFile.bind(host);
	const fileExists = host.fileExists.bind(host);
	host.readFile = (file) => virtual.get(file)?.code ?? readFile(file);
	host.fileExists = (file) => virtual.has(file) || fileExists(file);
	const program = ts.createProgram(
		[...new Set([...sourceFiles, ...entries.map((e) => e.source).filter(Boolean)])],
		options,
		host,
	);
	const checker = program.getTypeChecker();
	const nodes = [
		...packages,
		...entries.map(({ id, label, kind, package: pkg, parentId, entry, source }) => ({
			id,
			label,
			kind,
			package: pkg,
			parentId,
			entry,
			source: source
				? { path: slash(path.relative(root, source)), line: 1, column: 1, snippet: "" }
				: undefined,
		})),
	];
	const nodesById = new Map(nodes.map((n) => [n.id, n]));
	const symbolNodes = new Map(),
		declarationNodes = new Map(),
		implementationNodes = new Map(),
		declaredReleases = new Map(),
		relationships = new Map();
	const unalias = (symbol) => {
		const seen = new Set();
		while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) {
			seen.add(symbol);
			symbol = checker.getAliasedSymbol(symbol);
		}
		return symbol;
	};
	const register = (map, key, id) => {
		if (!key) return;
		if (!map.has(key)) map.set(key, new Set());
		map.get(key).add(id);
	};
	const sourceAt = (node) => {
		const file = node.getSourceFile();
		let pos = file.getLineAndCharacterOfPosition(node.getStart());
		const mapped = virtual.get(file.fileName);
		if (mapped) {
			const original = originalPositionFor(mapped.map, {
				line: pos.line + 1,
				column: pos.character,
			});
			if (original.line !== null) pos = { line: original.line - 1, character: original.column };
		}
		const lines = (mapped?.original ?? file.text).split("\n");
		return {
			path: slash(path.relative(root, mapped?.file ?? file.fileName)),
			line: pos.line + 1,
			column: pos.character + 1,
			snippetStart: Math.max(1, pos.line - 2),
			snippet: lines.slice(Math.max(0, pos.line - 3), pos.line + 4).join("\n"),
		};
	};
	const isTestPath = (file) =>
		/(^|\/)(__tests__|tests|fixtures)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
	const addEvidence = (id, evidence) => {
		const node = nodesById.get(id);
		if (!node) return;
		node.evidence ??= [];
		const list = node.evidence;
		if (
			!list.some(
				(item) =>
					item.kind === evidence.kind &&
					item.source.path === evidence.source.path &&
					item.source.line === evidence.source.line &&
					item.source.column === evidence.source.column,
			)
		)
			list.push(evidence);
	};
	function addSymbol(
		symbol,
		name,
		entry,
		parentId,
		qualified,
		ancestors = new Set(),
		explicitDeclarations,
	) {
		symbol = unalias(symbol);
		if (!symbol || ancestors.has(symbol)) return;
		const declarations = explicitDeclarations ?? symbol.declarations ?? [];
		if (!declarations.length) return;
		// Apparent members of aliases (and inherited built-ins) share global symbols.
		// Registering String.replace under Label would count every string call as API use.
		if (
			qualified &&
			declarations.every((d) => program.isSourceFileDefaultLibrary(d.getSourceFile()))
		)
			return;
		const declaration = declarations[0];
		if (declarations.some((d) => d.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)))
			return;
		const isStatic = declarations.some((d) =>
			d.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword),
		);
		const kind = ts.isConstructorDeclaration(declaration)
			? "constructor"
			: ts.isClassDeclaration(declaration)
				? "class"
				: ts.isInterfaceDeclaration(declaration)
					? "interface"
					: ts.isTypeAliasDeclaration(declaration)
						? "type"
						: ts.isFunctionDeclaration(declaration)
							? "function"
							: ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)
								? "method"
								: ts.isEnumDeclaration(declaration)
									? "enum"
									: ts.isModuleDeclaration(declaration) || ts.isSourceFile(declaration)
										? "namespace"
										: ts.isPropertyDeclaration(declaration) ||
												ts.isPropertySignature(declaration) ||
												ts.isGetAccessorDeclaration(declaration) ||
												ts.isSetAccessorDeclaration(declaration)
											? "property"
											: ts.isEnumMember(declaration)
												? "enum-member"
												: "variable";
		const identity = qualified ? `${qualified}.${isStatic ? "static:" : ""}${name}` : name;
		const id = stableId("api", entry.package, entry.entry, identity);
		for (const d of declarations) register(declarationNodes, d, id);
		if (!explicitDeclarations) register(symbolNodes, symbol, id);
		if (nodesById.has(id)) return id;
		const tags = symbol.getJsDocTags(checker);
		let annotationOwner = declaration;
		if (ts.isBindingElement(declaration) || ts.isVariableDeclaration(declaration)) {
			while (
				annotationOwner.parent &&
				!ts.isVariableStatement(annotationOwner) &&
				!ts.isSourceFile(annotationOwner)
			)
				annotationOwner = annotationOwner.parent;
		}
		const explicitRelease = ts
			.getJSDocTags(annotationOwner)
			.find((tag) => ["public", "internal", "alpha", "beta"].includes(tag.tagName.text))
			?.tagName.text;
		if (explicitRelease) declaredReleases.set(id, explicitRelease);
		const parent = nodesById.get(parentId);
		const release = tags.some((t) => t.name === "public")
			? "public"
			: tags.some((t) => t.name === "internal")
				? "internal"
				: tags.some((t) => t.name === "beta")
					? "beta"
					: tags.some((t) => t.name === "alpha")
						? "alpha"
						: (parent?.release ?? "internal");
		const signatures = declarations.map((d) => {
			let text = d.getText();
			if (ts.isSourceFile(d)) return `export namespace ${name}`;
			if (d.body) text = text.slice(0, d.body.getStart() - d.getStart()).trim();
			if (ts.isVariableDeclaration(d))
				text = `${d.name.getText()}: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, d), d, ts.TypeFormatFlags.NoTruncation)}`;
			if (["class", "interface", "namespace", "enum"].includes(kind))
				text = text.split("{")[0].trim();
			return text;
		});
		const hasSideEffects = (item) => {
			if (ts.isBindingElement(item)) {
				let owner = item.parent;
				while (owner && !ts.isVariableDeclaration(owner)) owner = owner.parent;
				return owner ? hasSideEffects(owner) : true;
			}
			if (ts.isVariableDeclaration(item))
				return (
					!!item.initializer &&
					![
						ts.SyntaxKind.StringLiteral,
						ts.SyntaxKind.NumericLiteral,
						ts.SyntaxKind.TrueKeyword,
						ts.SyntaxKind.FalseKeyword,
						ts.SyntaxKind.ArrowFunction,
						ts.SyntaxKind.FunctionExpression,
					].includes(item.initializer.kind)
				);
			if (ts.isClassDeclaration(item))
				return (
					!!item.heritageClauses?.length ||
					!!ts.getDecorators(item)?.length ||
					item.members.some(
						(member) =>
							ts.isClassStaticBlockDeclaration(member) ||
							ts.getDecorators(member)?.length ||
							(member.modifiers?.some(
								(modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
							) &&
								member.initializer),
					)
				);
			if (ts.isEnumDeclaration(item))
				return item.members.some(
					(member) =>
						member.initializer &&
						!ts.isStringLiteral(member.initializer) &&
						!ts.isNumericLiteral(member.initializer),
				);
			return false;
		};

		const node = {
			id,
			label: name,
			qualifiedName: identity,
			kind,
			package: entry.package,
			entry: entry.entry,
			parentId,
			release: explicitRelease ?? release,
			signatures: [...new Set(signatures)],
			documentation: ts.displayPartsToString(symbol.getDocumentationComment(checker)),
			source: sourceAt(declaration),
			extraction: "source",
			implementationId: stableId(
				"declaration",
				slash(path.relative(root, declaration.getSourceFile().fileName)),
				symbol.getName?.() ?? name,
			),
			sideEffects: hasSideEffects(declaration),
		};
		nodes.push(node);
		nodesById.set(id, node);
		if (!["interface", "type", "namespace", "enum"].includes(kind)) {
			const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
			const signatures = type.getCallSignatures();
			node.callable =
				signatures.length > 0 || type.getConstructSignatures().length > 0 || kind === "constructor";
			if (kind === "variable" || kind === "property") {
				for (const signature of signatures) {
					const implementation = signature.declaration;
					if (
						!implementation?.body ||
						implementation.getSourceFile().fileName.includes("/node_modules/")
					)
						continue;
					if (
						implementation.getSourceFile() === declaration.getSourceFile() &&
						implementation.getStart() >= declaration.getStart() &&
						implementation.getEnd() <= declaration.getEnd()
					)
						continue;
					register(implementationNodes, implementation, id);
					addEvidence(id, {
						kind: "implementation",
						label: "Callable implementation",
						detail:
							"This binding exposes this implementation. Calls through other objects or factory instances do not prove use of this exported binding.",
						source: sourceAt(implementation),
					});
				}
			}
		}
		if (
			ts.isBindingElement(declaration) &&
			ts.isObjectBindingPattern(declaration.parent) &&
			ts.isVariableDeclaration(declaration.parent.parent)
		) {
			const initializer = declaration.parent.parent.initializer;
			if (initializer) {
				const property = (declaration.propertyName ?? declaration.name).getText();
				const origin = ts.isCallExpression(initializer)
					? `${initializer.expression.getText()}(…)`
					: initializer.getText();
				addEvidence(id, {
					kind: "binding",
					label: `Bound from ${origin}.${property}`,
					detail:
						"Destructuring gives this value a separate exported name; the original object can be used without referencing that name.",
					source: sourceAt(declaration),
				});
			}
		}
		const next = new Set(ancestors).add(symbol);
		if (["class", "interface", "type"].includes(kind)) {
			const type = checker.getDeclaredTypeOfSymbol(symbol);
			const members = new Map(checker.getPropertiesOfType(type).map((s) => [s.getName(), s]));
			for (const [memberName, member] of members) {
				if (memberName.startsWith("#")) continue;
				addSymbol(member, memberName, entry, id, identity, next);
			}
			if (kind === "class") {
				for (const member of symbol.exports?.values() ?? [])
					if (member.name !== "prototype")
						addSymbol(member, member.getName(), entry, id, identity, next);
				const constructors = declarations.flatMap(
					(d) => d.members?.filter((m) => ts.isConstructorDeclaration(m)) ?? [],
				);
				if (constructors.length)
					addSymbol(
						{
							...symbol,
							declarations: constructors,
							getJsDocTags: () => [],
							getDocumentationComment: () => [],
						},
						"constructor",
						entry,
						id,
						identity,
						next,
						constructors,
					);
			}
		}
		if (["namespace", "enum"].includes(kind))
			for (const member of symbol.exports?.values() ?? [])
				addSymbol(member, member.getName(), entry, id, identity, next);
		return id;
	}
	for (const entry of entries) {
		const file = entry.source && program.getSourceFile(entry.source);
		const symbol = file && checker.getSymbolAtLocation(file);
		if (!symbol) {
			diagnostics.push({
				severity: "error",
				scope: entry.id,
				message: "No source module resolved for this entry point.",
			});
			continue;
		}
		for (const exported of checker.getExportsOfModule(symbol))
			addSymbol(exported, exported.getName(), entry, entry.id, "");
		const model = models.get(entry.id);
		const visit = (item, qualified = "") => {
			const name = item.kind === "Constructor" ? "constructor" : item.name;
			const next = name
				? qualified
					? `${qualified}.${item.isStatic ? "static:" : ""}${name}`
					: name
				: qualified;
			const node = nodesById.get(stableId("api", entry.package, entry.entry, next));
			if (node) {
				if (node.extraction !== "extractor") {
					node.signatures = [];
					node.extraction = "extractor";
				}
				const signature = item.excerptTokens?.map((t) => t.text).join("");
				if (signature && !node.signatures.includes(signature)) node.signatures.push(signature);
				if (item.docComment) node.documentation = item.docComment;
				if (item.releaseTag && item.releaseTag !== "None" && !declaredReleases.has(node.id))
					node.release = item.releaseTag.toLowerCase();
				node.canonicalReference = item.canonicalReference;
			}
			for (const member of item.members ?? []) visit(member, next);
		};
		for (const entryModel of model?.members ?? [])
			for (const item of entryModel.members ?? []) visit(item);
		const defaultExport = checker
			.getExportsOfModule(symbol)
			.find((exported) => exported.getName() === "default");
		if (defaultExport) {
			const declaration =
				file.statements.find(
					(statement) => ts.isExportAssignment(statement) && !statement.isExportEquals,
				) ?? file;
			const manifest = readJson(entry.manifestPath);
			const extension = manifest.leitwerk?.extension;
			const isExtensionEntry =
				typeof extension?.source === "string" &&
				path.resolve(entry.folder, extension.source) === entry.source;
			for (const id of symbolNodes.get(unalias(defaultExport)) ?? []) {
				const exportedNode = nodesById.get(id);
				if (exportedNode?.package !== entry.package || exportedNode.entry !== entry.entry) continue;
				addEvidence(id, {
					kind: "default-export",
					label: "Default export",
					detail:
						"Consumers can import this value under a different name or load the module dynamically.",
					source: sourceAt(declaration),
				});
				if (isExtensionEntry)
					addEvidence(id, {
						kind: "extension-entry",
						label: "Declared extension entry",
						detail:
							"The manifest exposes this module for extension loading. This is a declared integration role, not proof that a running deployment enables it.",
						source: packages.find((pkg) => pkg.name === entry.package).source,
					});
			}
		}
	}
	const occurrences = [],
		occurrenceKeys = new Set();
	const packageAt = (fileName) => {
		const relative = slash(path.relative(root, fileName));
		return packages.find((pkg) => relative.startsWith(`${pkg.path}/`))?.name;
	};
	const moduleAt = (node) => {
		for (let current = node; current && !ts.isSourceFile(current); current = current.parent) {
			if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current))
				return current.moduleSpecifier;
			if (
				ts.isImportEqualsDeclaration(current) &&
				ts.isExternalModuleReference(current.moduleReference)
			)
				return current.moduleReference.expression;
			if (ts.isImportTypeNode(current) && ts.isLiteralTypeNode(current.argument))
				return current.argument.literal;
		}
	};
	const modulePackages = (specifier) => {
		const symbol = specifier && checker.getSymbolAtLocation(specifier);
		return [
			...new Set(
				(symbol?.declarations ?? [])
					.map((d) => packageAt(d.getSourceFile().fileName))
					.filter(Boolean),
			),
		];
	};
	const importedModule = (symbol) => symbol?.declarations?.map(moduleAt).find(Boolean);
	const targetPackages = (node, symbol, targets) => {
		// Follow the import actually used, including namespace/static access. The
		// resolved symbol alone also contains unrelated re-exports and inherited members.
		let receiver = node;
		if (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent))
			receiver = node.parent.expression;
		while (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver))
			receiver = receiver.expression;
		const specifier =
			moduleAt(node) ??
			importedModule(checker.getSymbolAtLocation(receiver)) ??
			importedModule(symbol);
		if (specifier) return modulePackages(specifier);
		return [
			...new Set(
				[...targets]
					.map((id) => {
						const target = nodesById.get(id);
						return target?.source && packageAt(path.resolve(root, target.source.path));
					})
					.filter(Boolean),
			),
		].sort();
	};
	function category(node) {
		for (let p = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
			if (ts.isImportDeclaration(p) || ts.isImportEqualsDeclaration(p)) return "import";
			if (ts.isExportDeclaration(p) || ts.isExportAssignment(p)) return "re-export";
			if (ts.isTypeNode(p) || ts.isHeritageClause(p)) return "type";
			if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
				let target = p.expression;
				while (ts.isParenthesizedExpression(target) || ts.isNonNullExpression(target))
					target = target.expression;
				if (ts.isPropertyAccessExpression(target)) target = target.name;
				else if (ts.isElementAccessExpression(target)) target = target.argumentExpression;
				// The receiver of Class.method() is a reference, not a second call site.
				if (node === target) return "call";
				break;
			}
			if (ts.isStatement(p)) break;
		}
		return "other";
	}
	for (const fileName of sourceFiles) {
		const file = program.getSourceFile(fileName);
		if (!file) continue;
		const filePath = slash(path.relative(root, virtual.get(fileName)?.file ?? fileName));
		const isTest = isTestPath(filePath);
		const owner = packages.find((p) => filePath.startsWith(`${p.path}/`));
		const fileId = stableId("file", filePath);
		let fileAdded = false;
		const visit = (node) => {
			if (virtual.has(fileName) && ts.isIdentifier(node)) {
				const pos = file.getLineAndCharacterOfPosition(node.getStart());
				const mapped = virtual.get(fileName);
				const original = originalPositionFor(mapped.map, {
					line: pos.line + 1,
					column: pos.character,
				});
				if (
					original.line === null ||
					!mapped.original
						.split("\n")
						[original.line - 1]?.slice(original.column)
						.startsWith(node.text)
				)
					return;
			}
			if (ts.isCallExpression(node)) {
				const signature = checker.getResolvedSignature(node);
				for (const id of implementationNodes.get(signature?.declaration) ?? [])
					addEvidence(id, {
						kind: "implementation-call",
						label: `${node.expression.getText()}(…)`,
						detail:
							"This calls the same implementation. The receiver may be a different factory instance; it is not counted as a caller of the exported binding.",
						source: sourceAt(node),
						isTest,
					});
			}
			if (
				ts.isIdentifier(node) ||
				(ts.isStringLiteral(node) && ts.isElementAccessExpression(node.parent))
			) {
				const parent = node.parent;
				const isBinding =
					parent.name === node &&
					!ts.isPropertyAccessExpression(parent) &&
					!ts.isImportSpecifier(parent) &&
					!ts.isExportSpecifier(parent) &&
					!ts.isImportClause(parent) &&
					!ts.isNamespaceImport(parent) &&
					!ts.isShorthandPropertyAssignment(parent);
				if (!isBinding) {
					const originalSymbol = ts.isShorthandPropertyAssignment(parent)
						? checker.getShorthandAssignmentValueSymbol(parent)
						: checker.getSymbolAtLocation(node);
					const symbol = unalias(originalSymbol);
					const targets = new Set(symbolNodes.get(symbol) ?? []);
					const call =
						ts.isCallExpression(parent) || ts.isNewExpression(parent)
							? parent
							: ts.isPropertyAccessExpression(parent) &&
									(ts.isCallExpression(parent.parent) || ts.isNewExpression(parent.parent))
								? parent.parent
								: undefined;
					if (call && call.expression.getEnd() === node.getEnd()) {
						const signature = checker.getResolvedSignature(call);
						for (const id of declarationNodes.get(signature?.declaration) ?? []) targets.add(id);
					}
					if (targets.size) {
						const kind = category(node),
							source = sourceAt(node);
						if (!fileAdded) {
							nodes.push({
								id: fileId,
								label: path.basename(fileName),
								kind: "file",
								package: owner?.name ?? "(repository)",
								source: {
									path: filePath,
									line: 1,
									column: 1,
									snippetStart: 1,
									snippet: file.text.split("\n").slice(0, 7).join("\n"),
								},
								isTest,
							});
							fileAdded = true;
						}
						const key = `${filePath}:${node.getStart()}:${kind}`;
						if (!occurrenceKeys.has(key)) {
							occurrenceKeys.add(key);
							const ids = [...targets].sort();
							occurrences.push({
								id: hash(key),
								fileId,
								targets: ids,
								targetPackages: targetPackages(node, originalSymbol, targets),
								routeTargets: (() => {
									const specifier = moduleAt(node) ?? importedModule(originalSymbol);
									if (
										!specifier ||
										!ts.isStringLiteral(specifier) ||
										specifier.text.startsWith(".")
									)
										return [];
									return ids.filter((id) => {
										const target = nodesById.get(id);
										return (
											target &&
											specifier.text ===
												target.package + (target.entry === "." ? "" : target.entry.slice(1)) &&
											(target.qualifiedName.split(".")[0] ===
												(originalSymbol?.declarations?.find((d) => ts.isImportSpecifier(d))
													?.propertyName?.text ?? originalSymbol?.getName()) ||
												originalSymbol?.declarations?.some((d) => ts.isNamespaceImport(d)))
										);
									});
								})(),
								kind,
								isTest,
								...source,
							});
							if (kind === "type") {
								let current = node.parent,
									owners;
								while (current && !owners) {
									owners = declarationNodes.get(current);
									current = current.parent;
								}
								for (const from of owners ?? [])
									for (const to of ids)
										if (from !== to)
											relationships.set(`${from}->${to}`, { from, to, kind: "type" });
							}
						}
					}
				}
			}
			if (ts.isExportDeclaration(node) && !node.exportClause && node.moduleSpecifier) {
				const moduleSymbol = checker.getSymbolAtLocation(node.moduleSpecifier);
				const targets = new Set();
				for (const exported of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
					for (const id of symbolNodes.get(unalias(exported)) ?? []) targets.add(id);
				}
				if (targets.size) {
					const source = sourceAt(node.moduleSpecifier);
					if (!fileAdded) {
						nodes.push({
							id: fileId,
							label: path.basename(fileName),
							kind: "file",
							package: owner?.name ?? "(repository)",
							source: {
								path: filePath,
								line: 1,
								column: 1,
								snippetStart: 1,
								snippet: file.text.split("\n").slice(0, 7).join("\n"),
							},
							isTest,
						});
						fileAdded = true;
					}
					occurrences.push({
						id: hash(`${filePath}:${node.getStart()}:re-export`),
						fileId,
						targets: [...targets].sort(),
						targetPackages: modulePackages(node.moduleSpecifier),
						kind: "re-export",
						isTest,
						...source,
					});
				}
			}
			if (
				ts.isImportDeclaration(node) &&
				ts.isStringLiteral(node.moduleSpecifier) &&
				!checker.getSymbolAtLocation(node.moduleSpecifier) &&
				!node.moduleSpecifier.text.endsWith(".svelte")
			)
				diagnostics.push({
					severity: "warning",
					scope: filePath,
					message: `Unresolved import: ${node.moduleSpecifier.text}`,
				});
			ts.forEachChild(node, visit);
		};
		visit(file);
	}
	for (const diagnostic of program.getSyntacticDiagnostics())
		diagnostics.push({
			severity: "error",
			scope: diagnostic.file ? slash(path.relative(root, diagnostic.file.fileName)) : "source",
			message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
		});
	let revision = "unknown",
		dirty = false,
		origin = "";
	try {
		revision = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		dirty = !!execFileSync("git", ["status", "--porcelain"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
	} catch {
		/* Fixtures need not be git repositories. */
	}
	try {
		origin = execFileSync("git", ["config", "--get", "remote.origin.url"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		/* Local repositories have no remote. */
	}
	const errors = diagnostics.filter((d) => d.severity === "error").length;
	return {
		contentFingerprint: hash(
			sourceFiles
				.map(
					(file) =>
						`${slash(path.relative(root, file))}\0${virtual.get(file)?.original ?? fs.readFileSync(file, "utf8")}`,
				)
				.join("\0"),
		),
		version: 1,
		repository: {
			id: hash(origin || path.resolve(root)),
			name: path.basename(root),
			revision,
			dirty,
		},
		generatedAt: new Date().toISOString(),
		coverage: {
			complete: errors === 0 && !diagnostics.some((d) => d.message.startsWith("Unresolved import")),
			sourceFiles: sourceFiles.length,
			entryPoints: entries.length,
			extractedEntryPoints: models.size,
			typescriptVersion: ts.version,
			limitations: [
				"Static TS/JS and source-mapped Svelte references; dynamic calls and runtime dispatch are not traced.",
				"Coverage describes the loaded sources, never all possible consumers.",
				"Aliases exported through multiple entry points share occurrence evidence; package totals deduplicate it.",
				"Signatures with no Extractor match use source compiler data and are labeled.",
				"Wiring evidence records declared extension entries, exported bindings and shared implementations; it does not prove runtime activation or use of a specific factory instance.",
			],
		},
		nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
		occurrences,
		relationships: [...relationships.values()],
		diagnostics,
	};
}
