import { Router } from 'express';
import { requireAuth,requireRole } from '../middleware/auth.js';
import { readCompanyMatrix,requestCompanyMatrix } from '../services/company-matrix.js';
export const companyMatrixRouter=Router();
companyMatrixRouter.get('/company-matrix',requireAuth,async(req,res)=>{
 res.set('Cache-Control','no-store');
 res.json(await readCompanyMatrix(req.user.organization_id));
});
companyMatrixRouter.post('/company-matrix/refresh',requireAuth,requireRole('owner','admin','analyst'),async(req,res)=>{
 await requestCompanyMatrix(req.user.organization_id);
 res.status(202).json({queued:true});
});
