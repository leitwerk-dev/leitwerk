import { existsSync, readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import {
	type ApiItem,
	type ApiSurface,
	annotationNode,
	apiPackages,
	apiProgram,
	apiSurface,
	releaseTags,
	unalias,
} from "./api-surface.js";

/**
 * TypeScript retains tags on declared members but drops some tags when expanding
 * inferred, spread, and mapped types. Pair the source and emitted type graphs to
 * copy the originating member's explicit tag; never inherit a container's tag.
 */
export function declarationBindings(
	source: ApiSurface,
	built: ApiSurface,
): {
	bindings: Map<ts.Declaration, Set<ApiItem>>;
	diagnostics: string[];
} {
	const bindings = new Map<ts.Declaration, Set<ApiItem>>();
	const diagnostics: string[] = [];
	const ownedFiles = new Set(source.items.map((item) => item.node.getSourceFile().fileName));
	const pairs = new Map<ts.Type, Set<ts.Type>>();
	const bind = (original: ts.Declaration | undefined, emitted: ts.Declaration | undefined) => {
		const item = original && source.byNode.get(original);
		if (!item || !emitted || !built.byNode.has(emitted)) return;
		const origins = bindings.get(emitted) ?? new Set<ApiItem>();
		origins.add(item);
		bindings.set(emitted, origins);
	};
	const symbol = (original: ts.Symbol, emitted: ts.Symbol) => {
		for (const declaration of emitted.declarations ?? [])
			for (const origin of original.declarations ?? []) bind(origin, declaration);
	};
	function signatures(original: readonly ts.Signature[], emitted: readonly ts.Signature[]) {
		for (const [index, sig] of original.entries()) {
			const target = emitted[index];
			if (!target) continue;
			bind(sig.getDeclaration(), target.getDeclaration());
			for (const [i, param] of sig.parameters.entries()) {
				const other = target.parameters[i];
				const from = param.valueDeclaration ?? param.declarations?.[0];
				const to = other?.valueDeclaration ?? other?.declarations?.[0];
				if (from && to)
					types(
						source.checker.getTypeOfSymbolAtLocation(param, from),
						built.checker.getTypeOfSymbolAtLocation(other, to),
					);
			}
			types(sig.getReturnType(), target.getReturnType());
			for (const [i, param] of (sig.typeParameters ?? []).entries())
				if (target.typeParameters?.[i]) types(param, target.typeParameters[i]);
		}
	}
	function types(original: ts.Type, emitted: ts.Type) {
		const seen = pairs.get(original) ?? new Set<ts.Type>();
		if (seen.has(emitted)) return;
		seen.add(emitted);
		pairs.set(original, seen);
		if (original.aliasSymbol?.name === emitted.aliasSymbol?.name) {
			for (const [i, arg] of (original.aliasTypeArguments ?? []).entries())
				if (emitted.aliasTypeArguments?.[i]) types(arg, emitted.aliasTypeArguments[i]);
		}
		const defined = (type: ts.Type) =>
			type.isUnion() ? type.types.filter((t) => !(t.flags & ts.TypeFlags.Undefined)) : [type];
		if (original.isUnion() && !emitted.isUnion() && defined(original).length === 1) {
			types(defined(original)[0], emitted);
			return;
		}
		if (emitted.isUnion() && !original.isUnion() && defined(emitted).length === 1) {
			types(original, defined(emitted)[0]);
			return;
		}
		if (original.isUnionOrIntersection() && emitted.isUnionOrIntersection()) {
			const key = (type: ts.Type, checker: ts.TypeChecker): string => {
				if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)))
					return checker.typeToString(type);
				const name = type.aliasSymbol?.name ?? type.getSymbol()?.name;
				if (name && !name.startsWith("__"))
					return `${name.replace(/\$\d+$/, "")}<${(type.aliasTypeArguments ?? []).map((arg) => checker.typeToString(arg)).join(",")}>`;
				return type
					.getProperties()
					.map((p) => {
						const at = p.valueDeclaration ?? p.declarations?.[0];
						const value = at && checker.getTypeOfSymbolAtLocation(p, at);
						return `${p.name}${value?.isLiteral() ? `:${checker.typeToString(value)}` : ""}`;
					})
					.sort()
					.join(",");
			};
			for (const part of original.types) {
				const match = emitted.types.find(
					(p) => key(p, built.checker) === key(part, source.checker),
				);
				if (match) types(part, match);
			}
			return;
		}
		if (original.isUnionOrIntersection() !== emitted.isUnionOrIntersection()) return;
		if (original.flags & ts.TypeFlags.TypeParameter) {
			const constraint = original.getConstraint();
			const target = emitted.getConstraint();
			if (constraint && target) types(constraint, target);
			return;
		}
		if (
			original.flags & ts.TypeFlags.Object &&
			(original as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference &&
			emitted.flags & ts.TypeFlags.Object &&
			(emitted as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
		) {
			const args = source.checker.getTypeArguments(original as ts.TypeReference);
			const otherArgs = built.checker.getTypeArguments(emitted as ts.TypeReference);
			const from = (original as ts.TypeReference).target;
			const to = (emitted as ts.TypeReference).target;
			if (from !== original || to !== emitted) {
				types(from, to);
				for (const [i, arg] of args.entries()) if (otherArgs[i]) types(arg, otherArgs[i]);
				return;
			}
		}
		const from = original.getSymbol();
		const to = emitted.getSymbol();
		if (
			from &&
			to &&
			!from.name.startsWith("__") &&
			!to.name.startsWith("__") &&
			from.name.replace(/\$\d+$/, "") !== to.name.replace(/\$\d+$/, "")
		)
			return;
		if (from && to && from.name.replace(/\$\d+$/, "") === to.name.replace(/\$\d+$/, ""))
			symbol(from, to);
		if (
			from &&
			!from.declarations?.some((node) => ownedFiles.has(node.getSourceFile().fileName)) &&
			!original
				.getProperties()
				.some((property) => property.declarations?.some((node) => source.byNode.has(node)))
		)
			return;
		if (
			original.flags &
			(ts.TypeFlags.StringLike |
				ts.TypeFlags.NumberLike |
				ts.TypeFlags.BooleanLike |
				ts.TypeFlags.Any |
				ts.TypeFlags.Unknown)
		)
			return;
		for (const property of original.getProperties()) {
			const target = emitted.getProperty(property.name);
			const declarations = (property.declarations ?? []).filter((d) => source.byNode.has(d));
			if (!target) {
				for (const declaration of declarations)
					diagnostics.push(
						`${source.byNode.get(declaration)?.id}: member missing from built declarations`,
					);
				continue;
			}
			symbol(property, target);
			const a = property.valueDeclaration ?? property.declarations?.[0];
			const b = target.valueDeclaration ?? target.declarations?.[0];
			if (a && b && declarations.length)
				types(
					source.checker.getTypeOfSymbolAtLocation(property, a),
					built.checker.getTypeOfSymbolAtLocation(target, b),
				);
		}
		signatures(original.getCallSignatures(), emitted.getCallSignatures());
		signatures(original.getConstructSignatures(), emitted.getConstructSignatures());
		const indices = source.checker.getIndexInfosOfType(original);
		const otherIndices = built.checker.getIndexInfosOfType(emitted);
		for (const [i, info] of indices.entries())
			if (otherIndices[i]) {
				bind(info.declaration, otherIndices[i].declaration);
				types(info.type, otherIndices[i].type);
			}
	}
	for (const [key, originals] of source.exports) {
		const targets = built.exports.get(key);
		if (!targets) {
			diagnostics.push(`${key}: export missing from built declarations`);
			continue;
		}
		for (const original of originals)
			for (const target of targets) {
				bind(original.node, target.node);
				types(
					source.checker.getTypeAtLocation(original.node),
					built.checker.getTypeAtLocation(target.node),
				);
				if (
					(ts.isClassDeclaration(original.node) || ts.isInterfaceDeclaration(original.node)) &&
					original.node.name &&
					(ts.isClassDeclaration(target.node) || ts.isInterfaceDeclaration(target.node)) &&
					target.node.name
				) {
					const a = source.checker.getSymbolAtLocation(original.node.name);
					const b = built.checker.getSymbolAtLocation(target.node.name);
					if (a && b) {
						types(
							source.checker.getDeclaredTypeOfSymbol(unalias(source.checker, a)),
							built.checker.getDeclaredTypeOfSymbol(unalias(built.checker, b)),
						);
						types(
							source.checker.getTypeOfSymbolAtLocation(a, original.node),
							built.checker.getTypeOfSymbolAtLocation(b, target.node),
						);
					}
				}
			}
	}
	return { bindings, diagnostics };
}

export function preserveDeclarationAnnotations(root: string, write: boolean): string[] {
	const packages = apiPackages(root);
	const emitted = apiPackages(root, "types");
	const source = apiSurface(apiProgram(packages), packages);
	const built = apiSurface(apiProgram(emitted), emitted);
	const { bindings, diagnostics } = declarationBindings(source, built);
	diagnostics.push(...source.diagnostics, ...built.diagnostics);
	const edits = new Map<string, Map<number, string>>();
	for (const [node, origins] of bindings) {
		const tags = new Set([...origins].flatMap((item) => item.tags));
		const existing = releaseTags(node);
		const id = built.byNode.get(node)?.id;
		if (tags.size !== 1) {
			diagnostics.push(`${id}: ambiguous or missing source classification`);
			continue;
		}
		const [tag] = tags;
		if (existing.includes(tag) && new Set(existing).size === 1) continue;
		if (existing.length || !write) {
			diagnostics.push(`${id}: emitted classification must be @${tag}`);
			continue;
		}
		const annotation = annotationNode(node);
		const file = node.getSourceFile();
		const start = annotation.getStart();
		const prefix = file.text.slice(file.text.lastIndexOf("\n", start - 1) + 1, start);
		const indentation = prefix.match(/^\s*/)?.[0] ?? "";
		const insertion = /^\s*$/.test(prefix)
			? `/** @${tag} */\n${indentation}`
			: `\n${indentation}/** @${tag} */\n${indentation}`;
		const changes = edits.get(file.fileName) ?? new Map<number, string>();
		if (changes.has(start) && changes.get(start) !== insertion) {
			diagnostics.push(`${id}: conflicting emitted declaration tags`);
			continue;
		}
		changes.set(start, insertion);
		edits.set(file.fileName, changes);
	}
	if (diagnostics.length) return diagnostics;
	for (const [file, changes] of edits) {
		let content = readFileSync(file, "utf8");
		const original = content;
		for (const [offset, insertion] of [...changes].sort(([a], [b]) => b - a))
			content = content.slice(0, offset) + insertion + content.slice(offset);
		writeFileSync(file, content);
		// Declaration maps use one semicolon-delimited mapping per generated line.
		// The emitter puts declarations on separate lines; inserted comments add
		// unmapped lines while retaining every original column mapping.
		const mapFile = `${file}.map`;
		if (existsSync(mapFile)) {
			const map = JSON.parse(readFileSync(mapFile, "utf8"));
			const lines = map.mappings.split(";") as string[];
			for (const [offset, insertion] of [...changes].sort(([a], [b]) => b - a)) {
				const line = original.slice(0, offset).split("\n").length - 1;
				lines.splice(line, 0, ...Array<string>(insertion.split("\n").length - 1).fill(""));
			}
			map.mappings = lines.join(";");
			writeFileSync(mapFile, JSON.stringify(map));
		}
	}
	return [];
}
