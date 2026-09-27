-- Run outside a transaction to avoid blocking live ingestion.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_processes_search_normalized ON secop.processes (trim(saas.match_text(procurement_method)),trim(saas.match_text(process_status)));
