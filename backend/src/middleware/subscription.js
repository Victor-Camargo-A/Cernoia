import { config } from "../config.js";
import { query } from "../db.js";

export function requireEntitlement(feature) {
  return async (req, res, next) => {
    if (!config.subscriptionEnforced) return next();
    try {
      const result = await query(
        `SELECT subscription.status, subscription.current_period_end,
                COALESCE(plan.features ->> $2, 'false')::BOOLEAN AS feature_enabled
         FROM saas.subscriptions subscription
         JOIN saas.subscription_plans plan ON plan.code = subscription.plan_code
         WHERE subscription.organization_id = $1
         LIMIT 1`,
        [req.user.organization_id, feature],
      );
      const subscription = result.rows[0];
      const periodActive = !subscription?.current_period_end
        || new Date(subscription.current_period_end).getTime() > Date.now();
      if (!subscription || subscription.status !== "active" || !periodActive || !subscription.feature_enabled) {
        return res.status(402).json({
          error: "Esta función requiere una suscripción activa.",
          code: "SUBSCRIPTION_REQUIRED",
        });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
