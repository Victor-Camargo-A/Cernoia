import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePlatformAuth } from '../middleware/platform-auth.js';
import { ownerCampaignAuth } from '../services/campaigns.js';

export const ownerUsersRouter = Router();

async function listUsers(req, res, next) {
  try {
    const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
    const search = String(req.query.search ?? '').trim().slice(0, 150);
    // Global reads are restricted to the authenticated platform administrator
    // or the configured CernoIA owner; an ordinary tenant owner is not enough.
    const result = await pool.query(`
      SELECT u.id, u.email, u.full_name, u.role, u.status, u.last_login_at,
             o.name AS organization_name, o.status AS organization_status,
             p.name AS plan_name, s.status AS subscription_status,
             s.current_period_end, s.next_payment_due_at, s.paid_cycles,
             CASE WHEN s.status='active' AND s.current_period_end <= NOW()
                  THEN 'expired' ELSE s.status END AS effective_subscription_status,
             COUNT(*) OVER()::integer AS total
      FROM saas.app_users u
      JOIN saas.organizations o ON o.id=u.organization_id
      LEFT JOIN saas.subscriptions s ON s.organization_id=o.id
      LEFT JOIN saas.subscription_plans p ON p.code=s.plan_code
      WHERE $1='' OR strpos(lower(u.full_name || ' ' || u.email || ' ' || o.name), lower($1))>0
      ORDER BY u.created_at DESC, u.id
      LIMIT 50 OFFSET $2`, [search, (page - 1) * 50]);
    res.set('Cache-Control', 'no-store');
    res.json({ items: result.rows.map(({total, ...row}) => row), total: result.rows[0]?.total ?? 0, page });
  } catch (error) { next(error); }
}

ownerUsersRouter.get('/owner/users', requireAuth, ownerCampaignAuth, listUsers);
ownerUsersRouter.get('/platform/users', requirePlatformAuth, listUsers);
