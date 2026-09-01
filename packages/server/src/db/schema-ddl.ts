import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { getTableConfig, SQLiteDialect } from "drizzle-orm/sqlite-core";

const sqliteDialect = new SQLiteDialect();

function renderSql(value: Parameters<SQLiteDialect["sqlToQuery"]>[0]): string {
	const query = sqliteDialect.sqlToQuery(value);
	if (query.params.length > 0) throw new Error("DDL constraints must not contain bound parameters");
	return query.sql;
}

function sqlStringLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function buildForeignKeyMap(
	table: SQLiteTable,
): Map<string, { table: string; column: string; onDelete?: string; onUpdate?: string }> {
	const cfg = getTableConfig(table);
	const fkMap = new Map<
		string,
		{ table: string; column: string; onDelete?: string; onUpdate?: string }
	>();
	for (const fk of cfg.foreignKeys) {
		const ref = fk.reference();
		if (ref.columns.length !== 1) continue;
		const refTable = getTableConfig(ref.foreignTable).name;
		fkMap.set(ref.columns[0].name, {
			table: refTable,
			column: ref.foreignColumns[0].name,
			...(fk.onDelete ? { onDelete: String(fk.onDelete).toUpperCase() } : {}),
			...(fk.onUpdate ? { onUpdate: String(fk.onUpdate).toUpperCase() } : {}),
		});
	}
	return fkMap;
}

function columnDef(
	col: SQLiteColumn,
	fkMap: Map<string, { table: string; column: string; onDelete?: string; onUpdate?: string }>,
): string {
	const parts: string[] = [col.name, col.getSQLType()];

	if ((col as unknown as { primary: boolean }).primary) {
		parts.push("PRIMARY KEY");
	}
	if (col.notNull) {
		parts.push("NOT NULL");
	}
	if (col.hasDefault && col.default !== undefined) {
		const val = col.default;
		parts.push(`DEFAULT ${typeof val === "string" ? sqlStringLiteral(val) : String(val)}`);
	}

	const fk = fkMap.get(col.name);
	if (fk) {
		parts.push(`REFERENCES ${fk.table}(${fk.column})`);
		if (fk.onDelete) {
			parts.push(`ON DELETE ${fk.onDelete}`);
		}
		if (fk.onUpdate) {
			parts.push(`ON UPDATE ${fk.onUpdate}`);
		}
	}

	return parts.join(" ");
}

export function getTableName(table: SQLiteTable): string {
	return getTableConfig(table).name;
}

export function generateCreateTableDDL(
	table: SQLiteTable,
	extraConstraints: readonly string[] = [],
): string {
	const cfg = getTableConfig(table);
	const fkMap = buildForeignKeyMap(table);
	const definitions = cfg.columns.map((column) => `\t${columnDef(column, fkMap)}`);
	for (const fk of cfg.foreignKeys) {
		const ref = fk.reference();
		if (ref.columns.length === 1) continue;
		const foreignTable = getTableConfig(ref.foreignTable).name;
		const columns = ref.columns.map((column) => column.name).join(", ");
		const foreignColumns = ref.foreignColumns.map((column) => column.name).join(", ");
		const actions = [
			fk.onDelete ? ` ON DELETE ${String(fk.onDelete).toUpperCase()}` : "",
			fk.onUpdate ? ` ON UPDATE ${String(fk.onUpdate).toUpperCase()}` : "",
		].join("");
		definitions.push(
			`\tFOREIGN KEY (${columns}) REFERENCES ${foreignTable}(${foreignColumns})${actions}`,
		);
	}
	for (const constraint of cfg.checks) {
		definitions.push(`\tCONSTRAINT ${constraint.name} CHECK (${renderSql(constraint.value)})`);
	}
	for (const constraint of extraConstraints) {
		definitions.push(`\t${constraint}`);
	}
	return `CREATE TABLE IF NOT EXISTS ${cfg.name} (\n${definitions.join(",\n")}\n)`;
}

export function generateCreateIndexDDL(table: SQLiteTable): string[] {
	const cfg = getTableConfig(table);
	return cfg.indexes.map((idx) => {
		const unique = idx.config.unique ? "UNIQUE " : "";
		const colNames = idx.config.columns
			.map((column) => ("name" in column ? (column as SQLiteColumn).name : ""))
			.filter(Boolean)
			.join(", ");
		const where = idx.config.where ? ` WHERE ${renderSql(idx.config.where)}` : "";
		return `CREATE ${unique}INDEX IF NOT EXISTS ${idx.config.name} ON ${cfg.name}(${colNames})${where}`;
	});
}

export function generateDDL(tables: SQLiteTable[]): string[] {
	return tables.flatMap((table) => [
		generateCreateTableDDL(table),
		...generateCreateIndexDDL(table),
	]);
}
