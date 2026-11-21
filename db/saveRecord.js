import crypto from 'node:crypto';
import { pool } from './pool.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    const error = new Error(`Invalid ${label}: ${String(value)}`);
    error.statusCode = 400;
    error.code = 'INVALID_IDENTIFIER';
    throw error;
  }
}

function httpError(message, code = 'INVALID_INPUT') {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

export function normalizeInputRecords(data) {
  const records = Array.isArray(data) ? data : [data];
  if (!records.length) throw httpError('At least one record is required', 'EMPTY_RECORDS');
  if (records.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw httpError('Every record must be a plain object');
  }
  return records;
}

export function formatSqlDateTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw httpError('Invalid date', 'INVALID_DATE');
  const p = (n, size = 2) => String(n).padStart(size, '0');
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}.${p(date.getUTCMilliseconds() * 1000, 6)}`;
}

async function getColumns(executor, table) {
  const [rows] = await executor.execute(`SHOW COLUMNS FROM \`${table}\``);
  if (!rows.length) throw httpError(`Table '${table}' does not exist`, 'INVALID_TABLE');
  return new Set(rows.map((row) => row.Field));
}

export async function fetchLatestRowsByUuid(executor, table, uuidColumn, uuids) {
  if (!uuids.length) return new Map();
  const marks = uuids.map(() => '?').join(', ');
  const sql = `SELECT t.* FROM \`${table}\` t JOIN (SELECT \`${uuidColumn}\`, MAX(id) AS max_id FROM \`${table}\` WHERE \`${uuidColumn}\` IN (${marks}) GROUP BY \`${uuidColumn}\`) latest ON latest.max_id = t.id`;
  const [rows] = await executor.execute(sql, uuids);
  return new Map(rows.map((row) => [row[uuidColumn], row]));
}

function prepareRow(record, previous, columns, uuidColumn, now, options) {
  const row = { ...(previous || {}), ...record };
  if (uuidColumn) row[uuidColumn] = record[uuidColumn] || previous?.[uuidColumn] || (options.generateUuid ? crypto.randomUUID() : undefined);
  if (columns.has('version')) {
    row.version = previous ? Number(previous.version) + 1 : Number(record.version ?? 1);
  }
  if (columns.has('first_created_at')) {
    row.first_created_at = previous?.first_created_at || record.first_created_at || now;
  }
  if (columns.has('created_at')) row.created_at = now;
  delete row.id;
  const valid = {};
  for (const [key, value] of Object.entries(row)) {
    if (columns.has(key) && value !== undefined) valid[key] = value;
  }
  return valid;
}

export async function batchInsertRows(executor, table, rows, knownColumns) {
  if (!rows.length) return [];
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  columns.forEach((column) => assertIdentifier(column, 'column'));
  if (!columns.length) throw httpError('No insertable columns were supplied');
  if (columns.some((column) => !knownColumns.has(column))) throw httpError('An unknown column was supplied');

  const columnSql = columns.map((column) => `\`${column}\``).join(', ');
  const oneRow = `(${columns.map(() => '?').join(', ')})`;
  const valuesSql = rows.map(() => oneRow).join(', ');
  const params = rows.flatMap((row) => columns.map((column) => row[column] ?? null));
  const [result] = await executor.execute(`INSERT INTO \`${table}\` (${columnSql}) VALUES ${valuesSql}`, params);
  return rows.map((row, index) => ({ ...row, id: Number(result.insertId) + index }));
}

/** All application writes use this insert-only function. */
export async function saveRecord(table, data, options = {}) {
  assertIdentifier(table, 'table');
  const uuidColumn = options.uuidColumn === undefined ? 'uuid' : options.uuidColumn;
  if (uuidColumn !== null) assertIdentifier(uuidColumn, 'UUID column');

  const records = normalizeInputRecords(data);
  const executor = options.conn || pool;
  const columns = await getColumns(executor, table);
  if (uuidColumn && !columns.has(uuidColumn)) throw httpError(`UUID column '${uuidColumn}' does not exist in '${table}'`, 'INVALID_UUID_COLUMN');

  const mergeExisting = options.mergeExisting ?? Boolean(uuidColumn);
  const generateUuid = options.generateUuid ?? Boolean(uuidColumn);
  const uuids = uuidColumn && mergeExisting
    ? [...new Set(records.map((row) => row[uuidColumn]).filter((value) => typeof value === 'string' && value.trim()))]
    : [];
  const latest = uuidColumn && mergeExisting
    ? await fetchLatestRowsByUuid(executor, table, uuidColumn, uuids)
    : new Map();
  const now = formatSqlDateTime();

  const prepared = records.map((record) => {
    const previous = uuidColumn && mergeExisting ? latest.get(record[uuidColumn]) : undefined;
    return prepareRow(record, previous, columns, uuidColumn, now, { generateUuid });
  });
  return batchInsertRows(executor, table, prepared, columns);
}
