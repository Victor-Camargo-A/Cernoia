import {Router} from 'express';import rateLimit from 'express-rate-limit';
import {requireAuth} from '../middleware/auth.js';
import {ensureVisitor,recordVisitorEvent,completeDemo} from '../services/marketing.js';
export const marketingRouter=Router();
const limit=rateLimit({windowMs:60000,limit:45,standardHeaders:true,legacyHeaders:false});
marketingRouter.post('/events',limit,async(req,res,next)=>{try{
 const event=req.body?.event;if(!['landing_visited','demo_started','signup_started'].includes(event))return res.status(400).json({error:'Evento no permitido.'});
 if(event!=='landing_visited'&&req.body?.interaction!==true)return res.status(400).json({error:'Se requiere interacción con la interfaz.'});
 const visitor=await ensureVisitor(req,res);const recorded=await recordVisitorEvent(visitor,event);res.set('Cache-Control','no-store');res.json({recorded});
}catch(e){next(e);}});
marketingRouter.post('/demo-completed',requireAuth,limit,async(req,res,next)=>{try{
 const result=await completeDemo(req.user.organization_id,req.body?.analysis_id);res.set('Cache-Control','no-store');res.status(result.eligible?200:409).json(result);
}catch(e){next(e);}});
