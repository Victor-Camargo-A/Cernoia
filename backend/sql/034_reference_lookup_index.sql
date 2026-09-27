CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_processes_reference_lower ON secop.processes(lower(reference));
