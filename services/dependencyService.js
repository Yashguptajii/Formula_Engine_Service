const RESERVED_OR_HELPER_IDENTIFIERS = new Set([
  'return',
  'const',
  'let',
  'var',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'function',
  'true',
  'false',
  'null',
  'undefined',
  'NaN',
  'Infinity',
  'Math',
  'Number',
  'String',
  'Boolean',
  'Array',
  'Object',
  'JSON',
  'EXTERNAL_VAR',
  'CODE',
  'IF',
  'AND',
  'OR',
  'XOR',
  'SUM',
  'ROUND',
  'INT',
  'CONCATSTR',
  'STRLENGTH',
  'LOGICAL',
  'MATHS',
  'STRING'
]);

const IDENTIFIER_REGEX = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;

function stripStringsAndComments(source) {
  return String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/(["'])(?:\\.|(?!\1).)*\1/g, ' ');
}

/**
 * Extracts referenced input/formula names from formula_text.
 * Supports EXTERNAL_VAR.CODE.<name>, EXTERNAL_VAR.<name>, and bare <name>.
 */
export function extractReferencedNames(formulaText) {
  const cleaned = stripStringsAndComments(formulaText);
  const refs = new Set();

  // Match EXTERNAL_VAR.CODE.<name> or EXTERNAL_VAR.<name>
  const extRegex = /\bEXTERNAL_VAR\.(?:CODE\.)?([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of cleaned.matchAll(extRegex)) {
    const name = match[1];
    if (!RESERVED_OR_HELPER_IDENTIFIERS.has(name)) {
      refs.add(name);
    }
  }

  // Match standalone identifiers not preceded by a dot (and not followed by '(' for helper calls)
  for (const match of cleaned.matchAll(IDENTIFIER_REGEX)) {
    const name = match[1];
    const index = match.index ?? 0;
    const prevChar = index > 0 ? cleaned[index - 1] : '';
    const nextChar = cleaned[index + name.length] || '';

    if (prevChar === '.') continue;
    if (nextChar === '(') continue;
    if (RESERVED_OR_HELPER_IDENTIFIERS.has(name)) continue;

    refs.add(name);
  }

  return Array.from(refs);
}

/**
 * Validates that every referenced name exists either in another formula or in the input record.
 * Throws a 400 error listing missing inputs before any evaluation runs.
 */
export function validateAvailableInputs(formulas, inputRecord = {}) {
  const formulaNames = new Set(formulas.map((f) => f.name));
  const recordKeys = new Set(Object.keys(inputRecord || {}));
  const missingByFormula = [];

  for (const formula of formulas) {
    const refs = extractReferencedNames(formula.formula_text);
    const missing = refs.filter((ref) => !formulaNames.has(ref) && !recordKeys.has(ref));
    if (missing.length > 0) {
      missingByFormula.push({
        formula: formula.name,
        missingInputs: missing
      });
    }
  }

  if (missingByFormula.length > 0) {
    const flatMissing = [...new Set(missingByFormula.flatMap((m) => m.missingInputs))];
    const err = new Error(`Missing required inputs: ${flatMissing.join(', ')}`);
    err.statusCode = 400;
    err.code = 'MISSING_INPUTS';
    err.details = missingByFormula;
    throw err;
  }
}

/**
 * Builds dependency graph (formula -> [dependencies it reads]),
 * detects cycles with full path (e.g. a -> b -> c -> a),
 * and computes topological levels for parallel execution.
 */
export function buildExecutionPlan(formulas) {
  const byName = new Map();
  for (const f of formulas) {
    byName.set(f.name, f);
  }

  const dependencies = new Map(); // name -> Set<depName> (things `name` reads)
  const dependents = new Map();   // depName -> Set<name> (things that read `depName`)

  for (const f of formulas) {
    dependencies.set(f.name, new Set());
    dependents.set(f.name, new Set());
  }

  for (const f of formulas) {
    const refs = extractReferencedNames(f.formula_text);
    for (const ref of refs) {
      if (byName.has(ref) && ref !== f.name) {
        dependencies.get(f.name).add(ref);
        dependents.get(ref).add(f.name);
      } else if (ref === f.name) {
        const err = new Error(`Dependency cycle detected: ${f.name} -> ${f.name}`);
        err.statusCode = 400;
        err.code = 'DEPENDENCY_CYCLE';
        err.details = { cycle: [f.name, f.name], path: `${f.name} -> ${f.name}` };
        throw err;
      }
    }
  }

  // DFS cycle detection returning exact path like a -> b -> c -> a
  const state = new Map(); // 0 = unvisited, 1 = visiting, 2 = visited
  const stack = [];

  function dfs(nodeName) {
    state.set(nodeName, 1);
    stack.push(nodeName);

    for (const depName of dependencies.get(nodeName) || []) {
      const depState = state.get(depName) || 0;
      if (depState === 1) {
        const cycleStartIdx = stack.indexOf(depName);
        const cycleNodes = [...stack.slice(cycleStartIdx), depName];
        const cyclePath = cycleNodes.join(' -> ');
        const err = new Error(`Dependency cycle detected: ${cyclePath}`);
        err.statusCode = 400;
        err.code = 'DEPENDENCY_CYCLE';
        err.details = { cycle: cycleNodes, path: cyclePath };
        throw err;
      }
      if (depState === 0) {
        dfs(depName);
      }
    }

    stack.pop();
    state.set(nodeName, 2);
  }

  for (const f of formulas) {
    if ((state.get(f.name) || 0) === 0) {
      dfs(f.name);
    }
  }

  // Compute execution levels: level = 0 if no formula deps, else 1 + max(level of deps)
  const levelByName = new Map();

  function computeLevel(name) {
    if (levelByName.has(name)) {
      return levelByName.get(name);
    }
    const deps = Array.from(dependencies.get(name) || []);
    if (deps.length === 0) {
      levelByName.set(name, 0);
      return 0;
    }
    const maxDepLevel = Math.max(...deps.map((d) => computeLevel(d)));
    const level = maxDepLevel + 1;
    levelByName.set(name, level);
    return level;
  }

  for (const f of formulas) {
    computeLevel(f.name);
  }

  const levelsMap = new Map();
  for (const f of formulas) {
    const lvl = levelByName.get(f.name);
    if (!levelsMap.has(lvl)) {
      levelsMap.set(lvl, []);
    }
    levelsMap.get(lvl).push(f);
  }

  const sortedLevelNumbers = Array.from(levelsMap.keys()).sort((a, b) => a - b);
  const levels = sortedLevelNumbers.map((lvl) => ({
    level: lvl,
    formulas: levelsMap.get(lvl)
  }));

  return {
    levels,
    dependencies,
    dependents,
    orderedFormulas: levels.flatMap((l) => l.formulas)
  };
}

/**
 * Returns all formulas (direct and indirect) that depend on `targetName`.
 */
export function getImpactedFormulaNames(targetName, formulas) {
  const { dependents } = buildExecutionPlan(formulas);
  const visited = new Set();
  const queue = [...(dependents.get(targetName) || [])];

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of dependents.get(current) || []) {
      if (!visited.has(next)) {
        queue.push(next);
      }
    }
  }

  return Array.from(visited);
}