import { Router } from 'express';
import {
  getFormulas,
  getHistory,
  getImpact,
  postDeactivateFormula,
  postFormula,
  postPreview,
  postPreviewBulk,
  postRollbackFormula
} from '../controllers/formulaController.js';

const router = Router();

router.post('/', postFormula);
router.post('/preview', postPreview);
router.post('/preview/bulk', postPreviewBulk);
router.post('/:uuid/deactivate', postDeactivateFormula);
router.post('/:uuid/rollback', postRollbackFormula);
router.get('/', getFormulas);
router.get('/:uuid/history', getHistory);
router.get('/:uuid/impact', getImpact);

export default router;