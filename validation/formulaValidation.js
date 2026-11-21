const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const positiveInteger = (value) => Number.isInteger(Number(value)) && Number(value) > 0;

export function validateSaveFormulaBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object';
  const formulaText = body.formula_text ?? body.formulaText;
  const createdBy = body.created_by ?? body.createdBy;
  if (body.uuid !== undefined && (typeof body.uuid !== 'string' || !UUID_RE.test(body.uuid))) return 'uuid must be a valid UUID';
  if (!body.uuid && (typeof body.name !== 'string' || !body.name.trim())) return 'name is required when creating a formula';
  if (body.uuid && !positiveInteger(body.baseVersion)) return 'baseVersion must be a positive integer when changing a formula';
  if (formulaText !== undefined && (typeof formulaText !== 'string' || !formulaText.trim())) return 'formula_text must be a non-empty string';
  if (!body.uuid && formulaText === undefined) return 'formula_text is required when creating a formula';
  if (typeof createdBy !== 'string' || !createdBy.trim()) return 'created_by is required';
  if (body.status !== undefined && !['ACTIVE', 'INACTIVE'].includes(body.status)) return "status must be 'ACTIVE' or 'INACTIVE'";
  if (body.sampleData !== undefined && (!body.sampleData || typeof body.sampleData !== 'object' || Array.isArray(body.sampleData))) return 'sampleData must be an object';
  return null;
}

function validateFormulaUuids(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((uuid) => typeof uuid !== 'string' || !UUID_RE.test(uuid))) return 'formulaUuids must be an array of valid UUID strings';
  return null;
}

export function validatePreviewBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object';
  if (!body.record || typeof body.record !== 'object' || Array.isArray(body.record)) return 'record object is required';
  const uuidError = validateFormulaUuids(body.formulaUuids);
  if (uuidError) return uuidError;
  if (body.asOf !== undefined && Number.isNaN(new Date(body.asOf).getTime())) return 'asOf must be a valid timestamp';
  if (body.timeoutMs !== undefined && (!Number.isInteger(Number(body.timeoutMs)) || Number(body.timeoutMs) < 50 || Number(body.timeoutMs) > 30000)) return 'timeoutMs must be between 50 and 30000';
  return null;
}

export function validateBulkPreviewBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Request body must be a JSON object';
  if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 500) return 'records must contain between 1 and 500 records';
  if (body.records.some((record) => !record || typeof record !== 'object' || Array.isArray(record))) return 'Every item in records must be an object';
  const uuidError = validateFormulaUuids(body.formulaUuids);
  if (uuidError) return uuidError;
  if (body.asOf !== undefined && Number.isNaN(new Date(body.asOf).getTime())) return 'asOf must be a valid timestamp';
  if (body.timeoutMs !== undefined && (!Number.isInteger(Number(body.timeoutMs)) || Number(body.timeoutMs) < 50 || Number(body.timeoutMs) > 30000)) return 'timeoutMs must be between 50 and 30000';
  if (body.concurrency !== undefined && (!Number.isInteger(Number(body.concurrency)) || Number(body.concurrency) < 1 || Number(body.concurrency) > 50)) return 'concurrency must be between 1 and 50';
  return null;
}
