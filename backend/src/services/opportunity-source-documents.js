import {query} from '../db.js';
import {assertOpportunityAccess} from './bid-workspace.js';
// The official inventory is the identity of a document. Analysis copies remain
// historical records; only the latest copy supplies processing metadata.
export async function listOpportunitySourceDocuments(organizationId,processId){
 await assertOpportunityAccess(organizationId,processId);
 return (await query(`SELECT COALESCE(o.id,d.id) AS id,d.id AS process_document_id,p.reference AS process_reference,
 d.file_name AS document_name,d.file_extension AS source_file_extension,
 COALESCE(d.download_url_text,d.download_url->>'url') AS source_download_url,d.file_size_bytes AS source_file_size_bytes,
 o.primary_category,o.detected_categories,o.relevant_for_analysis,o.selected_for_download,
 COALESCE(o.download_status,'pending') AS download_status,o.downloaded_at,o.downloaded_mime_type,
 o.downloaded_file_extension,o.downloaded_file_size_bytes,o.extraction_status,o.extracted_at,
 o.ai_requirement_status,o.ai_requirement_count,o.updated_at
 FROM secop.process_documents d JOIN secop.processes p ON p.id=d.process_id
 LEFT JOIN LATERAL(SELECT od.* FROM saas.opportunity_documents od
 LEFT JOIN saas.opportunity_ai_analyses a ON a.id=od.opportunity_analysis_id
 WHERE od.organization_id=$1 AND od.process_id=d.process_id AND od.process_document_id=d.id
 ORDER BY a.created_at DESC NULLS LAST,od.updated_at DESC,od.id DESC LIMIT 1)o ON TRUE
 WHERE d.process_id=$2 ORDER BY o.relevant_for_analysis DESC NULLS LAST,d.file_name,d.id`,[organizationId,processId])).rows;
}
