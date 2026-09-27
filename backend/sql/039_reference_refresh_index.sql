-- Keeps exact-reference matches accessible without scanning every historical match.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_process_matches_reference_refresh
ON saas.process_matches(organization_id,id)
WHERE matched_reasons->>'reference_lookup'='true';
