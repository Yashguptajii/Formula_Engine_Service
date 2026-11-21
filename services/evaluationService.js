import crypto from 'crypto';
import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';
import { saveRecord } from '../db/saveRecord.js';
import {
  buildExecutionPlan,
  extractReferencedNames,
  validateAvailableInputs
} from './dependencyService.js';

const require = createRequire(import.meta.url);
const { interpretor } = require('formula-interpreter');
// formula-interpreter 2.1.0 evaluates generated code that expects global require/__dirname.
// Its forked child inherits NODE_OPTIONS, so preload a small compatibility shim.
const interpreterBootstrap = fileURLToPath(
  new URL('../scripts/enable-global-require.cjs', import.meta.url)
);

const preloadOption = `--require=${interpreterBootstrap}`;

if (!String(process.env.NODE_OPTIONS || '').includes(interpreterBootstrap)) {
  process.env.NODE_OPTIONS = [
    process.env.NODE_OPTIONS,
    preloadOption
  ].filter(Boolean).join(' ');
}

const DEFAULT_LIBRARIES = ['LOGICAL', 'MATHS', 'STRING'];
const DEFAULT_TIMEOUT_MS = Number(process.env.FORMULA_TIMEOUT_MS || 2000);
const DEFAULT_BULK_CONCURRENCY = Number(process.env.BULK_PREVIEW_CONCURRENCY || 15);
const MAX_BULK_RECORDS = 500;

/**
 * Rounds numbers to 2 decimal places cleanly without binary floating-point
 * artifacts like 0.30000000000000004.
 */
export function roundToTwoDecimals(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return value;
  }
  const fixed = Number(value).toFixed(12);
  const num = Number(fixed);
  const sign = num < 0 ? -1 : 1;
  const absScaled = Math.round((Math.abs(num) * 100) + 1e-9);
  const rounded = Number(((sign * absScaled) / 100).toFixed(2));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Normalizes formula text so EXTERNAL_VAR.<name> and bare <name> work cleanly
 * inside `formula-interpreter` (`evalJob.js` expects `EXTERNAL_VAR.CODE.<name>`).
 */
export function prepareEvalString(formulaText, availableNamesSet) {
  let source = String(formulaText || '').trim();
  let output = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      output += ch;
      if (ch === '\\' && i + 1 < source.length) output += source[++i];
      else if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      output += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      output += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      output += source.slice(i, stop);
      i = stop;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++;
      const token = source.slice(i, j);
      const before = source.slice(0, i).match(/\s*$/)?.[0] || '';
      const previous = i - before.length - 1 >= 0 ? source[i - before.length - 1] : '';
      const after = source.slice(j).match(/^\s*/)?.[0] || '';
      const following = source[j + after.length] || '';
      if (token === 'EXTERNAL_VAR' && source.slice(j, j + 1) === '.') {
        output += token;
      } else if (availableNamesSet.has(token) && previous !== '.' && following !== '(') {
        output += `EXTERNAL_VAR.CODE.${token}`;
      } else {
        output += token;
      }
      i = j;
      continue;
    }
    output += ch;
    i++;
  }
  output = output.replace(/\bEXTERNAL_VAR\.(?!CODE\b)([A-Za-z_][A-Za-z0-9_]*)/g, 'EXTERNAL_VAR.CODE.$1');
  if (!/\breturn\b/.test(output)) output = `return ${output}`;
  return output;
}

function buildExplanation({ formulaText, inputsUsed, interpreterCalculation, finalResult }) {
  const substitutedExpression = Object.entries(inputsUsed).reduce((acc, [k, v]) => {
    const renderedVal = typeof v === 'string' ? JSON.stringify(v) : String(v);
    return acc.replace(new RegExp(`\\b${k}\\b`, 'g'), renderedVal);
  }, formulaText);

  const substitutedSteps = [];
  if (interpreterCalculation) {
    for (const line of String(interpreterCalculation).split('\n')) {
      const trimmed = line.trim();
      if (trimmed) substitutedSteps.push(trimmed);
    }
  }
  substitutedSteps.push(`substituted: ${substitutedExpression}`);
  substitutedSteps.push(`result: ${String(finalResult)}`);

  return {
    inputs: inputsUsed,
    formula: formulaText,
    substitutedSteps,
    result: finalResult
  };
}

async function runSingleFormulaWithTimeout(evalString, payload, timeoutMs) {
  const externalVarPayload = { ...payload, CODE: { ...payload } };
  const result = await interpretor(
    evalString,
    DEFAULT_LIBRARIES,
    externalVarPayload,
    { timeout: timeoutMs, memoryInMB: 10 }
  );
  if (!result || result.status === 0) {
    throw new Error(result?.error || `Formula evaluation failed or timed out after ${timeoutMs}ms`);
  }
  return { value: result.data, calculation: result.calculation || '' };
}


/**
 * Evaluates a list of formulas against one data record.
 * Writes one run-log row per formula sharing a single `run_uuid` in one batch insert.
 */
export async function evaluateRecordFormulas({
  formulas,
  inputRecord = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  persistLogs = true,
  dbExecutor
}) {
  const startAll = Date.now();
  const runUuid = crypto.randomUUID();

  validateAvailableInputs(formulas, inputRecord);
  const { levels, dependents, orderedFormulas } = buildExecutionPlan(formulas);

  const availableNamesSet = new Set([
    ...Object.keys(inputRecord || {}),
    ...formulas.map((f) => f.name)
  ]);

  const contextValues = { ...(inputRecord || {}) };
  const failedOrSkipped = new Map(); // formulaName -> reason string
  const resultsByName = new Map();

  for (const levelGroup of levels) {
    await Promise.all(
      levelGroup.formulas.map(async (formula) => {
        const refs = extractReferencedNames(formula.formula_text);
        const inputsUsed = {};
        for (const ref of refs) {
          if (Object.prototype.hasOwnProperty.call(contextValues, ref)) {
            inputsUsed[ref] = contextValues[ref];
          }
        }

        // Check if any dependency failed or was skipped
        const blockingDep = refs.find((ref) => failedOrSkipped.has(ref));
        if (blockingDep) {
          const reason = `Skipped because dependency '${blockingDep}' did not succeed (${failedOrSkipped.get(blockingDep)})`;
          failedOrSkipped.set(formula.name, reason);

          resultsByName.set(formula.name, {
            uuid: formula.uuid,
            formulaId: formula.id,
            name: formula.name,
            version: formula.version,
            status: 'SKIPPED',
            result: null,
            error: reason,
            durationMs: 0,
            explanation: {
              inputs: inputsUsed,
              formula: formula.formula_text,
              substitutedSteps: [reason],
              result: null
            }
          });
          return;
        }

        const fStart = Date.now();
        try {
          const evalString = prepareEvalString(formula.formula_text, availableNamesSet);
          const { value, calculation } = await runSingleFormulaWithTimeout(
            evalString,
            contextValues,
            timeoutMs
          );
          const rounded = typeof value === 'number' ? roundToTwoDecimals(value) : value;
          const durationMs = Date.now() - fStart;

          contextValues[formula.name] = rounded;

          resultsByName.set(formula.name, {
            uuid: formula.uuid,
            formulaId: formula.id,
            name: formula.name,
            version: formula.version,
            status: 'SUCCESS',
            result: rounded,
            error: null,
            durationMs,
            explanation: buildExplanation({
              formulaText: formula.formula_text,
              inputsUsed,
              interpreterCalculation: calculation,
              finalResult: rounded
            })
          });
        } catch (err) {
          const durationMs = Date.now() - fStart;
          const errMsg = err?.message || 'Unknown formula error';
          failedOrSkipped.set(formula.name, errMsg);

          resultsByName.set(formula.name, {
            uuid: formula.uuid,
            formulaId: formula.id,
            name: formula.name,
            version: formula.version,
            status: 'FAILED',
            result: null,
            error: errMsg,
            durationMs,
            explanation: {
              inputs: inputsUsed,
              formula: formula.formula_text,
              substitutedSteps: [`error: ${errMsg}`],
              result: null
            }
          });
        }
      })
    );
  }

  const orderedResults = orderedFormulas.map((f) => resultsByName.get(f.name));

  if (persistLogs && orderedResults.length > 0) {
    const logRows = orderedResults.map((item) => ({
      run_uuid: runUuid,
      formula_uuid: item.uuid,
      formula_id: item.formulaId,
      formula_name: item.name,
      formula_version: item.version,
      status: item.status,
      input_payload: JSON.stringify(item.explanation.inputs),
      result_value: typeof item.result === 'number' ? item.result : null,
      raw_result_text: item.result !== null && item.result !== undefined ? String(item.result) : null,
      calculation_text: item.explanation.substitutedSteps.join('\n'),
      error_message: item.error,
      duration_ms: item.durationMs
    }));

    await saveRecord('formula_run_logs', logRows, {
      uuidColumn: null,
      mergeExisting: false,
      generateUuid: false,
      conn: dbExecutor
    });
  }

  // Enrich record with all computed results
  const enrichedRecord = { ...(inputRecord || {}) };
  for (const item of orderedResults) {
    if (item.status === 'SUCCESS') {
      enrichedRecord[item.name] = item.result;
    }
  }

  return {
    runUuid,
    totalDurationMs: Date.now() - startAll,
    formulas: orderedResults,
    record: enrichedRecord,
    dependentsMap: Object.fromEntries(
      Array.from(dependents.entries()).map(([k, v]) => [k, Array.from(v)])
    )
  };
}

/**
 * Evaluates up to 500 records with controlled worker concurrency.
 */
export async function evaluateBulkFormulas({
  formulas,
  records,
  concurrency = DEFAULT_BULK_CONCURRENCY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  persistLogs = true,
  dbExecutor
}) {
  if (!Array.isArray(records) || records.length === 0) {
    const err = new Error('records must be a non-empty array');
    err.statusCode = 400;
    err.code = 'INVALID_RECORDS';
    throw err;
  }

  if (records.length > MAX_BULK_RECORDS) {
    const err = new Error(`Bulk preview supports at most ${MAX_BULK_RECORDS} records per request`);
    err.statusCode = 400;
    err.code = 'BULK_LIMIT_EXCEEDED';
    throw err;
  }

  // Validate the graph once and input availability independently for every record.
  buildExecutionPlan(formulas);
  const inputErrors = records.map((record) => {
    try { validateAvailableInputs(formulas, record); return null; }
    catch (error) { return error.message; }
  });

  const startBulk = Date.now();
  const safeConcurrency = Math.max(1, Math.min(concurrency, records.length));
  const outputs = new Array(records.length);
  let nextIndex = 0;
  let failureCount = 0;

  async function worker() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= records.length) break;
      try {
        if (inputErrors[idx]) throw Object.assign(new Error(inputErrors[idx]), { code: 'MISSING_INPUTS' });
        const evalOutput = await evaluateRecordFormulas({
          formulas, inputRecord: records[idx], timeoutMs, persistLogs, dbExecutor
        });
        const hasFailedOrSkipped = evalOutput.formulas.some(
          (formula) => formula.status === 'FAILED' || formula.status === 'SKIPPED'
        );
        if (hasFailedOrSkipped) failureCount++;
        outputs[idx] = {
          index: idx,
          runUuid: evalOutput.runUuid,
          record: evalOutput.record,
          formulas: evalOutput.formulas,
          status: hasFailedOrSkipped ? 'PARTIAL_FAILURE' : 'SUCCESS'
        };
      } catch (error) {
        failureCount++;
        outputs[idx] = {
          index: idx,
          runUuid: null,
          record: records[idx],
          formulas: [],
          status: 'FAILED',
          error: error.message
        };
      }
    }
  }

  await Promise.all(Array.from({ length: safeConcurrency }, () => worker()));

  const totalTimeMs = Date.now() - startBulk;
  const avgTimePerRecordMs = Number((totalTimeMs / records.length).toFixed(2));

  return {
    totalRecords: records.length,
    concurrency: safeConcurrency,
    totalTimeMs,
    avgTimePerRecordMs,
    failureCount,
    results: outputs
  };
}