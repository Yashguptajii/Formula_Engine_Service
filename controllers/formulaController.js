import {
  deactivateFormula,
  getFormulaHistory,
  getFormulaImpact,
  listCurrentFormulas,
  previewBulkRecords,
  previewSingleRecord,
  rollbackFormula,
  saveFormula
} from '../services/formulaService.js';
import {
  validateBulkPreviewBody,
  validatePreviewBody,
  validateSaveFormulaBody
} from '../validation/formulaValidation.js';

function badRequest(message, code = 'VALIDATION_ERROR') {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = code;
  return err;
}

export async function postFormula(req, res, next) {
  try {
    const validationErr = validateSaveFormulaBody(req.body);
    if (validationErr) return next(badRequest(validationErr));

    const saved = await saveFormula(req.body);
    const statusCode = req.body.uuid ? 200 : 201;
    res.status(statusCode).json({ data: saved });
  } catch (err) {
    next(err);
  }
}

export async function postDeactivateFormula(req, res, next) {
  try {
    const createdBy = req.body?.created_by ?? req.body?.createdBy;
    if (!createdBy) return next(badRequest('created_by is required'));

    const saved = await deactivateFormula(req.params.uuid, {
      created_by: createdBy,
      baseVersion: req.body?.baseVersion,
      force: Boolean(req.body?.force)
    });
    res.status(200).json({ data: saved });
  } catch (err) {
    next(err);
  }
}

export async function postRollbackFormula(req, res, next) {
  try {
    const createdBy = req.body?.created_by ?? req.body?.createdBy;
    if (!createdBy) return next(badRequest('created_by is required'));
    if (req.body?.version === undefined) return next(badRequest('version is required'));

    const saved = await rollbackFormula(req.params.uuid, {
      version: req.body.version,
      baseVersion: req.body.baseVersion,
      created_by: createdBy
    });
    res.status(200).json({ data: saved });
  } catch (err) {
    next(err);
  }
}

export async function getFormulas(req, res, next) {
  try {
    const includeInactive = req.query.includeInactive !== 'false';
    const formulas = await listCurrentFormulas({ includeInactive });
    res.status(200).json({ data: formulas });
  } catch (err) {
    next(err);
  }
}

export async function getHistory(req, res, next) {
  try {
    const history = await getFormulaHistory(req.params.uuid);
    res.status(200).json({ data: history });
  } catch (err) {
    next(err);
  }
}

export async function getImpact(req, res, next) {
  try {
    const impact = await getFormulaImpact(req.params.uuid);
    res.status(200).json({ data: impact });
  } catch (err) {
    next(err);
  }
}

export async function postPreview(req, res, next) {
  try {
    const validationErr = validatePreviewBody(req.body);
    if (validationErr) return next(badRequest(validationErr));

    const result = await previewSingleRecord(req.body);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function postPreviewBulk(req, res, next) {
  try {
    const validationErr = validateBulkPreviewBody(req.body);
    if (validationErr) return next(badRequest(validationErr));

    const result = await previewBulkRecords(req.body);
    res.status(200).json({ data: result });
  } catch (err) {
    next(err);
  }
}