import crypto from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';
import { formatSqlDateTime, saveRecord } from '../db/saveRecord.js';
import {
  buildExecutionPlan,
  getImpactedFormulaNames,
  extractReferencedNames
} from './dependencyService.js';
import {
  evaluateBulkFormulas,
  evaluateRecordFormulas
} from './evaluationService.js';

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function createHttpError(statusCode, code, message, details = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  if (details !== null) {
    err.details = details;
  }
  return err;
}

export function assertValidFormulaName(name) {
  if (typeof name !== 'string' || !IDENTIFIER_REGEX.test(name)) {
    throw createHttpError(
      400,
      'INVALID_FORMULA_NAME',
      `Formula name '${String(name)}' must be a valid identifier ([A-Za-z_][A-Za-z0-9_]*)`
    );
  }
}

async function getLatestRowByUuid(executor, uuid, { forUpdate = false } = {}) {
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const [rows] = await executor.execute(
    `SELECT * FROM formulas WHERE uuid = ? ORDER BY id DESC LIMIT 1${lockClause}`,
    [uuid]
  );
  return rows[0] || null;
}

export async function listCurrentFormulas({ includeInactive = true } = {}) {
  const sql = includeInactive
    ? 'SELECT * FROM v_current_formulas_subquery ORDER BY name ASC, id ASC'
    : "SELECT * FROM v_current_formulas_subquery WHERE status = 'ACTIVE' ORDER BY name ASC, id ASC";
  const [rows] = await pool.execute(sql);
  return rows;
}

export async function getFormulaHistory(uuid) {
  const [rows] = await pool.execute(
    'SELECT * FROM formulas WHERE uuid = ? ORDER BY id ASC',
    [uuid]
  );
  if (rows.length === 0) {
    throw createHttpError(404, 'FORMULA_NOT_FOUND', `No formula found with uuid '${uuid}'`);
  }
  return rows.map((row, idx) => ({
    ...row,
    history_version_number: idx + 1
  }));
}

export async function getFormulaImpact(uuid) {
  const currentFormulas = await listCurrentFormulas({ includeInactive: true });
  const target = currentFormulas.find((f) => f.uuid === uuid);
  if (!target) {
    throw createHttpError(404, 'FORMULA_NOT_FOUND', `No formula found with uuid '${uuid}'`);
  }

  const activeFormulas = currentFormulas.filter((f) => f.status === 'ACTIVE');
  const impactedNames = getImpactedFormulaNames(target.name, activeFormulas);
  const impactedFormulas = activeFormulas.filter((f) => impactedNames.includes(f.name));

  return {
    formula: target,
    impactedNames,
    impactedFormulas
  };
}

async function assertUniqueActiveName(executor, name, excludeUuid = null) {
  const [rows] = await executor.execute(
    "SELECT uuid, name, version FROM v_current_formulas_subquery WHERE status = 'ACTIVE' AND name = ?",
    [name]
  );
  const conflict = rows.find((r) => r.uuid !== excludeUuid);
  if (conflict) {
    throw createHttpError(
      400,
      'DUPLICATE_ACTIVE_FORMULA_NAME',
      `An active formula named '${name}' already exists`
    );
  }
}

async function assertNoCycleWithCandidate(candidateFormula, existingCurrentFormulas) {
  const others = existingCurrentFormulas.filter(
    (f) => f.status === 'ACTIVE' && f.uuid !== candidateFormula.uuid && f.name !== candidateFormula.name
  );
  const combined = [...others, candidateFormula];
  // buildExecutionPlan throws a 400 DEPENDENCY_CYCLE error with path `a -> b -> c -> a` if a cycle exists
  buildExecutionPlan(combined);
}

async function assertDryRunSucceeds(candidateFormula, existingCurrentFormulas, sampleData = {}) {
  const others = existingCurrentFormulas.filter(
    (formula) => formula.status === 'ACTIVE' &&
      formula.uuid !== candidateFormula.uuid && formula.name !== candidateFormula.name
  );
  const combined = [...others, candidateFormula];
  const record = { ...(sampleData && typeof sampleData === 'object' ? sampleData : {}) };
  const formulaNames = new Set(combined.map((formula) => formula.name));

  // Unknown references are provisionally treated as sample input fields. This permits
  // creating dependent formulas before their dependencies, as required by the brief.
  for (const formula of combined) {
    for (const reference of extractReferencedNames(formula.formula_text)) {
      if (!formulaNames.has(reference) && !Object.hasOwn(record, reference)) {
        record[reference] = 1;
      }
    }
  }

  let output;
  try {
    output = await evaluateRecordFormulas({ formulas: combined, inputRecord: record, persistLogs: false });
  } catch (error) {
    throw createHttpError(400, 'FORMULA_DRY_RUN_FAILED',
      `Formula '${candidateFormula.name}' failed validation: ${error.message}`, error.details || null);
  }
  const target = output.formulas.find((item) => item.name === candidateFormula.name);
  if (!target || target.status !== 'SUCCESS') {
    throw createHttpError(400, 'FORMULA_EVALUATION_FAILED',
      `Formula '${candidateFormula.name}' failed evaluation: ${target?.error || 'Unknown error'}`);
  }
}

async function withFormulaNameLock(conn, name, work) {
  const lockName = `formula-name:${crypto.createHash('sha256').update(name).digest('hex').slice(0, 48)}`;
  const [lockRows] = await conn.execute('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
  if (Number(lockRows[0]?.acquired) !== 1) {
    throw createHttpError(409, 'NAME_LOCK_TIMEOUT', `Could not acquire lock for formula name '${name}'`);
  }
  try {
    return await work();
  } finally {
    await conn.execute('SELECT RELEASE_LOCK(?)', [lockName]);
  }
}

async function assertNoBrokenActiveDependents(targetName, existingCurrentFormulas, force = false) {
  if (force) return;
  const activeFormulas = existingCurrentFormulas.filter((f) => f.status === 'ACTIVE');
  const impacted = getImpactedFormulaNames(targetName, activeFormulas);
  if (impacted.length > 0) {
    throw createHttpError(
      400,
      'ACTIVE_DEPENDENTS_EXIST',
      `Cannot modify or deactivate '${targetName}' because active formulas depend on it: ${impacted.join(', ')}`,
      { impactedFormulas: impacted }
    );
  }
}

/**
 * Creates a new formula (no uuid) or inserts a new version of an existing formula (uuid + baseVersion).
 */
export async function saveFormula(payload) {
  const {
    uuid, name, formula_text, formulaText, status, created_by, createdBy,
    baseVersion, sampleData = {}, force = false
  } = payload || {};
  const suppliedFormulaText = formula_text !== undefined ? formula_text : formulaText;
  const actor = created_by !== undefined ? created_by : createdBy;
  if (typeof actor !== 'string' || !actor.trim()) {
    throw createHttpError(400, 'INVALID_CREATED_BY', 'created_by is required');
  }
  if (status !== undefined && !['ACTIVE', 'INACTIVE'].includes(status)) {
    throw createHttpError(400, 'INVALID_STATUS', "status must be 'ACTIVE' or 'INACTIVE'");
  }

  if (!uuid) {
    assertValidFormulaName(name);
    if (typeof suppliedFormulaText !== 'string' || !suppliedFormulaText.trim()) {
      throw createHttpError(400, 'INVALID_FORMULA_TEXT', 'formula_text is required');
    }
    const nextStatus = status || 'ACTIVE';
    return withTransaction(async (conn) => withFormulaNameLock(conn, name, async () => {
      const [snapshot] = await conn.execute('SELECT * FROM v_current_formulas_subquery');
      await assertUniqueActiveName(conn, name);
      const candidate = {
        uuid: crypto.randomUUID(), name, version: 1,
        formula_text: suppliedFormulaText.trim(), status: nextStatus
      };
      await assertNoCycleWithCandidate(candidate, snapshot);
      if (nextStatus === 'ACTIVE') await assertDryRunSucceeds(candidate, snapshot, sampleData);
      const [saved] = await saveRecord('formulas', {
        uuid: candidate.uuid, name, formula_text: candidate.formula_text,
        status: nextStatus, created_by: actor.trim()
      }, { conn });
      return saved;
    }));
  }

  if (!Number.isInteger(Number(baseVersion)) || Number(baseVersion) < 1) {
    throw createHttpError(400, 'BASE_VERSION_REQUIRED', 'A positive baseVersion is required when changing a formula');
  }

  return withTransaction(async (conn) => {
    const current = await getLatestRowByUuid(conn, uuid, { forUpdate: true });
    if (!current) throw createHttpError(404, 'FORMULA_NOT_FOUND', `No formula found with uuid '${uuid}'`);
    if (Number(current.version) !== Number(baseVersion)) {
      throw createHttpError(409, 'VERSION_CONFLICT',
        `Conflict: expected baseVersion ${baseVersion}, but current version is ${current.version}`,
        { currentVersion: current });
    }

    const nextName = name === undefined ? current.name : name;
    const nextFormulaText = suppliedFormulaText === undefined ? current.formula_text : suppliedFormulaText;
    const nextStatus = status === undefined ? current.status : status;
    assertValidFormulaName(nextName);
    if (typeof nextFormulaText !== 'string' || !nextFormulaText.trim()) {
      throw createHttpError(400, 'INVALID_FORMULA_TEXT', 'formula_text cannot be empty');
    }

    return withFormulaNameLock(conn, nextName, async () => {
      const [snapshot] = await conn.execute('SELECT * FROM v_current_formulas_subquery');
      if (nextStatus === 'ACTIVE') await assertUniqueActiveName(conn, nextName, uuid);
      if (current.status === 'ACTIVE' && (nextName !== current.name || nextStatus !== 'ACTIVE')) {
        await assertNoBrokenActiveDependents(current.name, snapshot, force);
      }
      const candidate = {
        uuid, name: nextName, version: Number(current.version) + 1,
        formula_text: nextFormulaText.trim(), status: nextStatus
      };
      await assertNoCycleWithCandidate(candidate, snapshot);
      if (nextStatus === 'ACTIVE') await assertDryRunSucceeds(candidate, snapshot, sampleData);
      const [saved] = await saveRecord('formulas', {
        uuid, name: nextName, formula_text: candidate.formula_text,
        status: nextStatus, created_by: actor.trim()
      }, { conn });
      return saved;
    });
  });
}

export async function deactivateFormula(uuid, { created_by, baseVersion, force = false } = {}) {
  if (!created_by || typeof created_by !== 'string' || !created_by.trim()) {
    throw createHttpError(400, 'INVALID_CREATED_BY', 'created_by is required');
  }

  if (!Number.isInteger(Number(baseVersion)) || Number(baseVersion) < 1) {
    throw createHttpError(400, 'BASE_VERSION_REQUIRED', 'baseVersion is required for deactivation');
  }

  return withTransaction(async (conn) => {
    const currentRow = await getLatestRowByUuid(conn, uuid, { forUpdate: true });
    if (!currentRow) {
      throw createHttpError(404, 'FORMULA_NOT_FOUND', `No formula found with uuid '${uuid}'`);
    }
    if (Number(currentRow.version) !== Number(baseVersion)) {
      throw createHttpError(409, 'VERSION_CONFLICT', 'Formula has a newer version', { currentVersion: currentRow });
    }

    const [latestSnapshot] = await conn.execute('SELECT * FROM v_current_formulas_subquery');
    await assertNoBrokenActiveDependents(currentRow.name, latestSnapshot, force);

    const savedRows = await saveRecord(
      'formulas',
      {
        uuid,
        status: 'INACTIVE',
        created_by: created_by.trim()
      },
      { conn }
    );

    return savedRows[0];
  });
}

export async function rollbackFormula(uuid, { version, baseVersion, created_by } = {}) {
  if (version === undefined || version === null || Number.isNaN(Number(version))) {
    throw createHttpError(400, 'INVALID_VERSION', 'Target version is required for rollback');
  }
  if (!created_by || typeof created_by !== 'string' || !created_by.trim()) {
    throw createHttpError(400, 'INVALID_CREATED_BY', 'created_by is required');
  }

  if (!Number.isInteger(Number(baseVersion)) || Number(baseVersion) < 1) {
    throw createHttpError(400, 'BASE_VERSION_REQUIRED', 'baseVersion is required for rollback');
  }

  return withTransaction(async (conn) => {
    const currentRow = await getLatestRowByUuid(conn, uuid, { forUpdate: true });
    if (!currentRow) {
      throw createHttpError(404, 'FORMULA_NOT_FOUND', `No formula found with uuid '${uuid}'`);
    }
    if (Number(currentRow.version) !== Number(baseVersion)) {
      throw createHttpError(409, 'VERSION_CONFLICT', 'Formula has a newer version', { currentVersion: currentRow });
    }

    const [targetRows] = await conn.execute(
      'SELECT * FROM formulas WHERE uuid = ? AND version = ? ORDER BY id DESC LIMIT 1',
      [uuid, Number(version)]
    );
    const targetRow = targetRows[0];
    if (!targetRow) {
      throw createHttpError(
        404,
        'VERSION_NOT_FOUND',
        `Version ${version} not found for formula uuid '${uuid}'`
      );
    }

    const [latestSnapshot] = await conn.execute('SELECT * FROM v_current_formulas_subquery');
    const candidate = {
      uuid,
      name: targetRow.name,
      version: Number(currentRow.version) + 1,
      formula_text: targetRow.formula_text,
      status: targetRow.status
    };

    return withFormulaNameLock(conn, targetRow.name, async () => {
      if (targetRow.status === 'ACTIVE') {
        await assertUniqueActiveName(conn, targetRow.name, uuid);
        await assertNoCycleWithCandidate(candidate, latestSnapshot);
        await assertDryRunSucceeds(candidate, latestSnapshot, {});
      }
      if (currentRow.status === 'ACTIVE' &&
          (targetRow.status !== 'ACTIVE' || targetRow.name !== currentRow.name)) {
        await assertNoBrokenActiveDependents(currentRow.name, latestSnapshot, false);
      }

      const savedRows = await saveRecord('formulas', {
        uuid,
        name: targetRow.name,
        formula_text: targetRow.formula_text,
        status: targetRow.status,
        created_by: created_by.trim()
      }, { conn });
      return savedRows[0];
    });
  });
}

export async function resolveFormulasForPreview({ formulaUuids, asOf } = {}) {
  let rows;

  if (asOf) {
    const asOfDate = new Date(asOf);
    if (Number.isNaN(asOfDate.getTime())) {
      throw createHttpError(400, 'INVALID_AS_OF', 'asOf must be a valid timestamp');
    }
    const asOfSql = formatSqlDateTime(asOfDate);
    const [histRows] = await pool.execute(
      `
      SELECT f.*
      FROM formulas f
      INNER JOIN (
        SELECT uuid, MAX(id) AS max_id
        FROM formulas
        WHERE created_at <= ?
        GROUP BY uuid
      ) latest
        ON f.uuid = latest.uuid
       AND f.id = latest.max_id
      WHERE f.status = 'ACTIVE'
      `,
      [asOfSql]
    );
    rows = histRows;
  } else {
    const [curRows] = await pool.execute(
      "SELECT * FROM v_current_formulas_subquery WHERE status = 'ACTIVE'"
    );
    rows = curRows;
  }

  if (Array.isArray(formulaUuids) && formulaUuids.length > 0) {
    const requestedSet = new Set(formulaUuids);
    const matched = rows.filter((r) => requestedSet.has(r.uuid));
    if (matched.length !== requestedSet.size) {
      const foundUuids = new Set(matched.map((m) => m.uuid));
      const missing = formulaUuids.filter((u) => !foundUuids.has(u));
      throw createHttpError(
        404,
        'FORMULA_NOT_FOUND',
        `Some requested active formulas were not found at target time: ${missing.join(', ')}`
      );
    }
    return matched;
  }

  return rows;
}

export async function previewSingleRecord({ record, formulaUuids, asOf, timeoutMs }) {
  const formulas = await resolveFormulasForPreview({ formulaUuids, asOf });
  return evaluateRecordFormulas({
    formulas,
    inputRecord: record,
    timeoutMs,
    persistLogs: true
  });
}

export async function previewBulkRecords({ records, formulaUuids, asOf, concurrency, timeoutMs }) {
  const formulas = await resolveFormulasForPreview({ formulaUuids, asOf });
  return evaluateBulkFormulas({
    formulas,
    records,
    concurrency,
    timeoutMs,
    persistLogs: true
  });
}