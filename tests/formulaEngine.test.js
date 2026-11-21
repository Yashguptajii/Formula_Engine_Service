import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { pool } from '../db/pool.js';
import { saveRecord } from '../db/saveRecord.js';
import {
  buildExecutionPlan,
  getImpactedFormulaNames
} from '../services/dependencyService.js';
import {
  evaluateBulkFormulas,
  evaluateRecordFormulas,
  roundToTwoDecimals
} from '../services/evaluationService.js';
import {
  deactivateFormula,
  getFormulaHistory,
  rollbackFormula,
  saveFormula
} from '../services/formulaService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

function normalizeSqlDateTime(value) {
  if (value instanceof Date) {
    const pad = (number) => String(number).padStart(2, '0');

    return [
      value.getFullYear(),
      '-',
      pad(value.getMonth() + 1),
      '-',
      pad(value.getDate()),
      ' ',
      pad(value.getHours()),
      ':',
      pad(value.getMinutes()),
      ':',
      pad(value.getSeconds())
    ].join('');
  }

  return String(value).slice(0, 19);
}

async function resetTablesForTest() {
  // Test cleanup only; production application code never uses DELETE/UPDATE on business tables
  await pool.execute('SET FOREIGN_KEY_CHECKS = 0');
  await pool.execute('TRUNCATE TABLE formula_run_logs');
  await pool.execute('TRUNCATE TABLE formulas');
  await pool.execute('SET FOREIGN_KEY_CHECKS = 1');
}

describe('Formula Engine Service — Unit & Integration Tests', () => {
  before(async () => {
    await resetTablesForTest();
  });

  beforeEach(async () => {
    await resetTablesForTest();
  });

  after(async () => {
    await resetTablesForTest();
    await pool.end();
  });

  it('rounds numbers to 2 decimals without floating-point quirks like 0.30000000000000004', () => {
    assert.equal(roundToTwoDecimals(0.1 + 0.2), 0.3);
    assert.notEqual(String(roundToTwoDecimals(0.1 + 0.2)), '0.30000000000000004');
    assert.equal(roundToTwoDecimals(2000 * 10 / 100), 200);
    assert.equal(roundToTwoDecimals(200 * 0.18), 36);
    assert.equal(roundToTwoDecimals(1.005), 1.01);
  });

  it('resolves out-of-order dependencies (total, tax, commission) and matches worked example', async () => {
    // Created in reverse dependency order: total first, then tax, then commission
    await saveFormula({
      name: 'total',
      formula_text: 'return commission + tax;',
      created_by: 'admin'
    });
    await saveFormula({
      name: 'tax',
      formula_text: 'return commission * 0.18;',
      created_by: 'admin'
    });
    await saveFormula({
      name: 'commission',
      formula_text: 'return amount * rate / 100;',
      created_by: 'admin'
    });

    const [rows] = await pool.execute(
      "SELECT * FROM v_current_formulas_subquery WHERE status = 'ACTIVE'"
    );
    const plan = buildExecutionPlan(rows);
    assert.deepEqual(
      plan.orderedFormulas.map((f) => f.name),
      ['commission', 'tax', 'total']
    );

    const output = await evaluateRecordFormulas({
      formulas: rows,
      inputRecord: { amount: 2000, rate: 10 },
      persistLogs: true
    });

    assert.equal(output.record.commission, 200);
    assert.equal(output.record.tax, 36);
    assert.equal(output.record.total, 236);
    assert.ok(output.runUuid);
    assert.equal(output.formulas.length, 3);
  });

  it('detects dependency cycles and reports full path a -> b -> c -> a', async () => {
    assert.throws(
  () => buildExecutionPlan([
    { name: 'a', formula_text: 'return b + 1;' },
    { name: 'b', formula_text: 'return c + 1;' },
    { name: 'c', formula_text: 'return a + 1;' }
  ]),
  (err) => {
    assert.equal(err.statusCode, 400);
    assert.match(err.message, /a -> b -> c -> a/);
    return true;
  }
);
  });

  it('marks timed-out formula FAILED, marks downstream dependents SKIPPED, and runs independent formulas', async () => {
    const formulas = [
      {
        id: 1,
        uuid: '11111111-1111-1111-1111-111111111111',
        name: 'slow_calc',
        version: 1,
        formula_text: 'while (true) {} return 1;',
        status: 'ACTIVE'
      },
      {
        id: 2,
        uuid: '22222222-2222-2222-2222-222222222222',
        name: 'after_slow',
        version: 1,
        formula_text: 'return slow_calc + 10;',
        status: 'ACTIVE'
      },
      {
        id: 3,
        uuid: '33333333-3333-3333-3333-333333333333',
        name: 'independent_calc',
        version: 1,
        formula_text: 'return base * 2;',
        status: 'ACTIVE'
      }
    ];

    const res = await evaluateRecordFormulas({
      formulas,
      inputRecord: { base: 25 },
      timeoutMs: 250,
      persistLogs: false
    });

    const byName = Object.fromEntries(res.formulas.map((f) => [f.name, f]));
    assert.equal(byName.slow_calc.status, 'FAILED');
    assert.equal(byName.after_slow.status, 'SKIPPED');
    assert.match(byName.after_slow.error, /slow_calc/);
    assert.equal(byName.independent_calc.status, 'SUCCESS');
    assert.equal(byName.independent_calc.result, 50);
  });

  it('saveRecord creates new records and merges changes into a new row without mutating old rows', async () => {
    const created = await saveRecord('formulas', {
      name: 'commission',
      formula_text: 'return amount * rate / 100;',
      status: 'ACTIVE',
      created_by: 'alice'
    });

    assert.ok(created[0].id);
    assert.ok(created[0].uuid);
    assert.equal(created[0].version, 1);

    const updated = await saveRecord('formulas', {
      uuid: created[0].uuid,
      formula_text: 'return amount * 0.05;',
      created_by: 'bob'
    });

    assert.equal(updated[0].uuid, created[0].uuid);
    assert.ok(updated[0].id > created[0].id);
    assert.equal(updated[0].version, 2);
    assert.equal(updated[0].name, 'commission');
    assert.equal(
  normalizeSqlDateTime(updated[0].first_created_at),
  normalizeSqlDateTime(created[0].first_created_at)
);
    assert.equal(updated[0].created_by, 'bob');

    const history = await getFormulaHistory(created[0].uuid);
    assert.equal(history.length, 2);
  });

  it('returns 409 Conflict when two edits target the same baseVersion', async () => {
    const f1 = await saveFormula({
      name: 'tax',
      formula_text: 'return 100 * 0.18;',
      created_by: 'admin1'
    });

    // First edit at baseVersion 1 succeeds -> becomes version 2
    const v2 = await saveFormula({
      uuid: f1.uuid,
      formula_text: 'return 100 * 0.12;',
      baseVersion: 1,
      created_by: 'admin1'
    });
    assert.equal(v2.version, 2);

    // Second concurrent edit still using baseVersion 1 fails with 409 Conflict
    await assert.rejects(
      () =>
        saveFormula({
          uuid: f1.uuid,
          formula_text: 'return 100 * 0.20;',
          baseVersion: 1,
          created_by: 'admin2'
        }),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.details?.currentVersion?.version, 2);
        return true;
      }
    );
  });

  it('allows only one of two simultaneous edits based on the same version', async () => {
    const formula = await saveFormula({
      name: 'parallel_tax',
      formula_text: 'return amount * 0.18;',
      created_by: 'admin'
    });
    const attempts = await Promise.allSettled([
      saveFormula({ uuid: formula.uuid, baseVersion: 1, formula_text: 'return amount * 0.12;', created_by: 'admin-a' }),
      saveFormula({ uuid: formula.uuid, baseVersion: 1, formula_text: 'return amount * 0.15;', created_by: 'admin-b' })
    ]);
    assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
    const rejected = attempts.find((item) => item.status === 'rejected');
    assert.equal(rejected.reason.statusCode, 409);
  });

  it('blocks deactivation with active dependents unless forced, and supports rollback', async () => {
    const tax = await saveFormula({
      name: 'tax',
      formula_text: 'return 100 * 0.18;',
      created_by: 'admin'
    });
    await saveFormula({
      name: 'total',
      formula_text: 'return 100 + tax;',
      created_by: 'admin'
    });

    const [currentRows] = await pool.execute(
      "SELECT * FROM v_current_formulas_subquery WHERE status = 'ACTIVE'"
    );
    assert.deepEqual(getImpactedFormulaNames('tax', currentRows), ['total']);

    await assert.rejects(
      () => deactivateFormula(tax.uuid, { created_by: 'admin', baseVersion: 1, force: false }),
      (err) => {
        assert.equal(err.statusCode, 400);
        assert.ok(err.details?.impactedFormulas?.includes('total'));
        return true;
      }
    );

    const v2 = await saveFormula({
      uuid: tax.uuid,
      formula_text: 'return 100 * 0.12;',
      baseVersion: 1,
      created_by: 'admin'
    });
    assert.equal(v2.version, 2);

    const rolledBack = await rollbackFormula(tax.uuid, {
      version: 1,
      baseVersion: 2,
      created_by: 'admin'
    });
    assert.equal(rolledBack.version, 3);
    assert.equal(rolledBack.formula_text, 'return 100 * 0.18;');
  });

  it('evaluates bulk preview of 500 records within 30 seconds', async () => {
    const formulas = Array.from({ length: 10 }, (_, i) => {
      const name = `f_${i + 1}`;
      const expr =
        i === 0
          ? 'return base * 1.1;'
          : `return f_${i} + ${i + 1};`;
      return {
        id: i + 1,
        uuid: `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
        name,
        version: 1,
        formula_text: expr,
        status: 'ACTIVE'
      };
    });

    const records = Array.from({ length: 500 }, (_, idx) => ({
      base: idx + 1
    }));

    const bulkOut = await evaluateBulkFormulas({
      formulas,
      records,
      concurrency: 20,
      persistLogs: false
    });

    assert.equal(bulkOut.totalRecords, 500);
    assert.equal(bulkOut.failureCount, 0);
    assert.ok(bulkOut.totalTimeMs < 30000, `Expected < 30000ms, got ${bulkOut.totalTimeMs}ms`);
  });

  it('ensures src/ files contain no UPDATE or DELETE statements on business tables', () => {
    const srcDir = PROJECT_ROOT;
    const files = [];

    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'coverage') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    }

    walk(srcDir);

    const forbiddenSqlRegex = /\b(UPDATE|DELETE)\s+(FROM\s+)?(formulas|formula_run_logs)\b/i;
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      assert.equal(
        forbiddenSqlRegex.test(content),
        false,
        `Forbidden UPDATE/DELETE found in ${path.relative(PROJECT_ROOT, file)}`
      );
    }
  });
});