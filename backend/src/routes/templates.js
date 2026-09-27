import {authorizedTemplateSignature} from '../services/template-signature.js';
import { extname } from "node:path";
import { Router, raw } from "express";
import { query, withTenantTransaction } from "../db.js";
import { writeAudit } from "../audit.js";
import { config } from "../config.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireEntitlement } from "../middleware/subscription.js";
import { scanForMalware } from "../services/malware-scanner.js";
import {
  fileSha256,
  readStoredDocument,
  removeStoredDocument,
  storeDocument,
  streamStoredDocument,
  validateUploadedFile,
} from "../services/document-storage.js";
import { inspectTemplate, renderTemplate } from "../services/template-renderer.js";

export const templatesRouter = Router();
templatesRouter.use(requireAuth, requireEntitlement("document_automation"));

const SCOPE_VALUES = new Set(["organization", "entity", "process"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function downloadHeaders(res, filename, mimeType) {
  const safeName = String(filename ?? "documento").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150);
  res.set("Content-Type", mimeType || "application/octet-stream");
  res.set("Content-Disposition", `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Cache-Control", "private, no-store");
}

templatesRouter.get("/templates", async (req, res, next) => {
  try {
    const processFilter = req.query.processId ? String(req.query.processId) : null;
    if(processFilter && !UUID_PATTERN.test(processFilter))return res.status(400).json({error:"Proceso no válido."});
    const [templates, generated] = await Promise.all([
      query(
        `SELECT template.id, template.name, template.description, template.template_type,
                template.scope, template.entity_nit, template.process_id, template.status,
                template.current_version, template.created_at, template.updated_at,
                version.id AS version_id, version.original_filename, version.mime_type,
                version.file_size_bytes, version.field_schema, version.field_mapping
         FROM saas.document_templates template
         JOIN saas.document_template_versions version
           ON version.template_id = template.id AND version.version_number = template.current_version
         WHERE template.organization_id = $1 AND template.status <> 'archived' AND ($2::uuid IS NULL OR template.process_id=$2)
         ORDER BY template.updated_at DESC`,
        [req.user.organization_id,processFilter],
      ),
      query(
        `SELECT generated.id, generated.template_id, generated.process_id, generated.status,
                generated.validation_issues, generated.storage_url, generated.mime_type,
                generated.file_size_bytes, generated.generated_at, generated.created_at,
                template.name AS template_name, process.reference AS process_reference
         FROM saas.generated_template_documents generated
         JOIN saas.document_templates template ON template.id = generated.template_id
         LEFT JOIN secop.processes process ON process.id = generated.process_id
         WHERE generated.organization_id = $1 AND ($2::uuid IS NULL OR generated.process_id=$2)
         ORDER BY generated.created_at DESC LIMIT 100`,
        [req.user.organization_id,processFilter],
      ),
    ]);
    res.json({ templates: templates.rows, generated: generated.rows });
  } catch (error) {
    next(error);
  }
});

templatesRouter.post('/templates/upload',requireRole('owner','admin','analyst'),raw({type:()=>true,limit:config.documentUploadMaxBytes}),saveUploadedTemplate);

export async function saveUploadedTemplate(req,res,next) {
  const input=req.templateUpload?.metadata??req.query;
  const buffer=req.templateUpload?.buffer??req.body;

    let stored = null;
    try {
      const filename = String(input.filename ?? "").trim().slice(0, 255);
      const name = String(input.name ?? "").trim().slice(0, 180);
      const description = String(input.description ?? "").trim().slice(0, 1000);
      const scope = String(input.scope ?? "organization");
      const entityNit = String(input.entityNit ?? "").trim().slice(0, 80);
      const processId = String(input.processId ?? "").trim() || null;
      if (!name || !filename) return res.status(400).json({ error: "Nombre y archivo son obligatorios." });
      if (!SCOPE_VALUES.has(scope)) return res.status(400).json({ error: "Alcance de plantilla no válido." });
      if (processId && !UUID_PATTERN.test(processId)) return res.status(400).json({ error: "Proceso no válido." });
      if(processId) {
        const access=await query('SELECT 1 FROM saas.process_matches WHERE organization_id=$1 AND process_id=$2 LIMIT 1',[req.user.organization_id,processId]);
        if(!access.rowCount) return res.status(404).json({error:'Oportunidad no encontrada.'});
      }
      const validation = validateUploadedFile(buffer, filename);
      const extension = extname(filename).toLowerCase();
      if (!validation.valid || !['.docx', '.pdf', '.xlsx'].includes(extension)) {
        return res.status(415).json({ error: "Las plantillas deben ser DOCX, XLSX o PDF." });
      }
      await scanForMalware(buffer);
      const templateType = extension === ".docx" ? "docx" : extension === ".xlsx" ? "xlsx" : "pdf_form";
      const fields = await inspectTemplate(buffer, templateType);
      stored = await storeDocument({
        organizationId: req.user.organization_id,
        extension,
        buffer: buffer,
      });
      const fileHash = fileSha256(buffer);
      const templateResult = await query(
        `INSERT INTO saas.document_templates (
           organization_id, name, description, template_type, scope, entity_nit,
           process_id, created_by_user_id
         ) VALUES ($1, $2, NULLIF($3, ''), $4, $5, NULLIF($6, ''), $7, $8)
         RETURNING *`,
        [req.user.organization_id, name, description, templateType, scope, entityNit, processId, req.user.id],
      );
      const template = templateResult.rows[0];
      try {
        const versionResult = await query(
          `INSERT INTO saas.document_template_versions (
             template_id, organization_id, version_number, original_filename,
             storage_key, mime_type, file_size_bytes, file_hash_sha256,
             field_schema, source_metadata, created_by_user_id
           ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8::JSONB, $9::JSONB, $10)
           RETURNING *`,
          [
            template.id,
            req.user.organization_id,
            filename,
            stored.relativeKey,
            validation.mime,
            buffer.length,
            fileHash,
            JSON.stringify(fields),
            JSON.stringify({ encryption_version: stored.encryptionVersion }),
            req.user.id,
          ],
        );
        await writeAudit({
          userId: req.user.id,
          organizationId: req.user.organization_id,
          action: "document_template.created",
          entityType: "document_template",
          entityId: template.id,
          metadata: { template_type: templateType, fields: fields.length },
          req,
        });
        res.status(201).json({ template, version: versionResult.rows[0] });
      } catch (error) {
        await query("DELETE FROM saas.document_templates WHERE id = $1 AND organization_id = $2", [template.id, req.user.organization_id]);
        throw error;
      }
    } catch (error) {
      if (stored?.relativeKey) await removeStoredDocument(stored.relativeKey).catch(() => undefined);
      if (error.type === "entity.too.large") return res.status(413).json({ error: "La plantilla supera el límite permitido." });
      next(error);
    }
}

templatesRouter.patch("/templates/:templateId", requireRole("owner","admin","analyst"), async(req,res,next)=>{
 try {
  if(!UUID_PATTERN.test(req.params.templateId))return res.status(400).json({error:"Plantilla no válida."});
  const status=String(req.body?.status??"active");if(!['active','disabled','archived'].includes(status))return res.status(400).json({error:"Estado no válido."});
  const result=await withTenantTransaction(req.user.organization_id,async client=>{
   const row=(await client.query(`SELECT t.*,v.id AS version_id,v.field_schema,v.field_mapping FROM saas.document_templates t JOIN saas.document_template_versions v ON v.template_id=t.id AND v.version_number=t.current_version WHERE t.id=$1 AND t.organization_id=$2 FOR UPDATE OF t`,[req.params.templateId,req.user.organization_id])).rows[0];
   if(!row)throw Object.assign(Error("Plantilla no encontrada."),{statusCode:404});
   const mapping=req.body?.field_mapping&&typeof req.body.field_mapping==='object'?req.body.field_mapping:row.field_mapping;
   const schema=Array.isArray(req.body?.field_schema)?req.body.field_schema.slice(0,300):row.field_schema;
   const changed=(await client.query('SELECT $1::jsonb IS DISTINCT FROM $2::jsonb OR $3::jsonb IS DISTINCT FROM $4::jsonb AS changed',[JSON.stringify(mapping),JSON.stringify(row.field_mapping),JSON.stringify(schema),JSON.stringify(row.field_schema)])).rows[0].changed;
   const version=row.current_version+(changed?1:0);
   if(changed)await client.query(`INSERT INTO saas.document_template_versions(template_id,organization_id,version_number,original_filename,storage_key,mime_type,file_size_bytes,file_hash_sha256,field_schema,field_mapping,source_metadata,created_by_user_id)
    SELECT template_id,organization_id,$3,original_filename,storage_key,mime_type,file_size_bytes,file_hash_sha256,$4::jsonb,$5::jsonb,source_metadata,$6 FROM saas.document_template_versions WHERE id=$1 AND organization_id=$2`,[row.version_id,req.user.organization_id,version,JSON.stringify(schema),JSON.stringify(mapping),req.user.id]);
   return (await client.query(`UPDATE saas.document_templates SET name=COALESCE(NULLIF($3,''),name),description=$4,status=$5,current_version=$6,updated_at=NOW() WHERE id=$1 AND organization_id=$2 RETURNING *`,[row.id,req.user.organization_id,String(req.body?.name??'').slice(0,240),req.body?.description==null?row.description:String(req.body.description).slice(0,1000),status,version])).rows[0];
  });res.json({template:result});
 }catch(e){next(e);}
});

templatesRouter.post(
  "/templates/:templateId/generate",
  requireRole("owner", "admin", "analyst"),
  async (req, res, next) => {
    let stored = null;
    let generationId = null;
    try {
      const processId = String(req.body?.process_id ?? "").trim() || null;
      if (processId && !UUID_PATTERN.test(processId)) return res.status(400).json({ error: "Oportunidad no válida." });
      const source = await query(
        `SELECT template.id, template.name, template.template_type, template.current_version,
                version.id AS version_id, version.storage_key, version.original_filename,
                version.field_schema, version.field_mapping,
                organization.name AS organization_name, organization.legal_name,
                organization.tax_id, organization.city AS organization_city,
                organization.department AS organization_department, organization.website,
                organization.organization_type,
                process.reference AS process_reference, process.secop_process_id,
                process.process_name, process.entity_name, process.entity_nit,
                process.city AS process_city, process.department AS process_department,
                process.base_price, process.response_deadline, process.process_url
         FROM saas.document_templates template
         JOIN saas.document_template_versions version
           ON version.template_id = template.id AND version.version_number = template.current_version
         JOIN saas.organizations organization ON organization.id = template.organization_id
         LEFT JOIN secop.processes process ON process.id = $3
         WHERE template.id = $1 AND template.organization_id = $2 AND template.status = 'active' AND (template.process_id IS NULL OR template.process_id=$3)
         LIMIT 1`,
        [req.params.templateId, req.user.organization_id, processId],
      );
      if (!source.rowCount) return res.status(404).json({ error: "Plantilla activa no encontrada." });
      if (processId) {
        const access = await query(
          `SELECT 1 FROM saas.process_matches WHERE organization_id = $1 AND process_id = $2 LIMIT 1`,
          [req.user.organization_id, processId],
        );
        if (!access.rowCount) return res.status(404).json({ error: "Oportunidad no encontrada." });
      }
      const record = source.rows[0];
      const matrixContext=(await query('SELECT saas.company_matrix_analysis_context($1) AS context',[req.user.organization_id])).rows[0]?.context;
      const representatives=matrixContext?.can_analyze ? [...new Set((matrixContext.facts??[]).filter(f=>f.attribute==='legal_representative'&&f.evidence_status==='document_supported'&&!f.conflict).map(f=>f.value))] : [];
      const values = {
        organization_name: record.organization_name,
        legal_name: record.legal_name || record.organization_name,
        tax_id: record.tax_id,
        organization_city: record.organization_city,
        organization_department: record.organization_department,
        organization_website: record.website,
        organization_type: record.organization_type,
        representative_name: representatives.length===1?representatives[0]:"",
        representative_email: "",
        process_reference: record.process_reference || record.secop_process_id,
        process_name: record.process_name,
        entity_name: record.entity_name,
        entity_nit: record.entity_nit,
        process_city: record.process_city,
        process_department: record.process_department,
        base_price: record.base_price,
        response_deadline: record.response_deadline,
        process_url: record.process_url,
        date_today: new Date().toLocaleDateString("es-CO", { timeZone: "America/Bogota" }),
        ...(req.body?.field_values && typeof req.body.field_values === "object" ? req.body.field_values : {}),
      };
      const signature=await authorizedTemplateSignature(req.user,req.body??{});
      const pending = await query(
        `INSERT INTO saas.generated_template_documents (
           organization_id, template_id, template_version_id, process_id,
           created_by_user_id, status, field_values
         ) VALUES ($1, $2, $3, $4, $5, 'generating', $6::JSONB)
         RETURNING id`,
        [req.user.organization_id, record.id, record.version_id, processId, req.user.id, JSON.stringify(values)],
      );
      generationId = pending.rows[0].id;
      const sourceBuffer = await readStoredDocument(record.storage_key);
      const rendered = await renderTemplate({
        buffer: sourceBuffer,
        templateType: record.template_type,
        values,
        mapping: record.field_mapping,
        fieldSchema: record.field_schema,
        signature,
      });
      stored = await storeDocument({
        organizationId: req.user.organization_id,
        extension: rendered.extension,
        buffer: rendered.buffer,
      });
      const finalStatus = rendered.issues.length ? "needs_review" : "ready";
      const result = await query(
        `UPDATE saas.generated_template_documents
         SET status = $2, validation_issues = $3::JSONB, storage_key = $4,
             storage_url = $5, mime_type = $6, file_size_bytes = $7,
             file_hash_sha256 = $8, generated_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          generationId,
          finalStatus,
          JSON.stringify(rendered.issues),
          stored.relativeKey,
          `/api/generated-documents/${generationId}/file`,
          rendered.mimeType,
          rendered.buffer.length,
          fileSha256(rendered.buffer),
        ],
      );
      if(signature)await writeAudit({userId:req.user.id,organizationId:req.user.organization_id,action:'template.signature_applied',entityType:'generated_document',entityId:generationId,metadata:{signature_profile_id:signature.id,signature_hash:signature.hash,template_version_id:record.version_id,confirmation_version:'template-signature-v1'},req});
      res.status(201).json({ generated: result.rows[0] });
    } catch (error) {
      if (stored?.relativeKey) await removeStoredDocument(stored.relativeKey).catch(() => undefined);
      if (generationId) {
        await query(
          `UPDATE saas.generated_template_documents
           SET status = 'failed', error_message = LEFT($2, 2000), updated_at = NOW()
           WHERE id = $1`,
          [generationId, error.message],
        ).catch(() => undefined);
      }
      next(error);
    }
  },
);

templatesRouter.get("/generated-documents/:documentId/file", async (req, res, next) => {
  try {
    const result = await query(
      `SELECT generated.storage_key, generated.mime_type, template.name,
              CASE WHEN generated.mime_type = 'application/pdf' THEN '.pdf' WHEN generated.mime_type LIKE '%spreadsheetml%' THEN '.xlsx' ELSE '.docx' END AS extension
       FROM saas.generated_template_documents generated
       JOIN saas.document_templates template ON template.id = generated.template_id
       WHERE generated.id = $1 AND generated.organization_id = $2
         AND generated.status IN ('ready', 'needs_review')`,
      [req.params.documentId, req.user.organization_id],
    );
    if (!result.rowCount) return res.status(404).json({ error: "Documento generado no encontrado." });
    const record = result.rows[0];
    const stream = streamStoredDocument(record.storage_key);
    if (!stream) return res.status(404).json({ error: "Archivo no disponible." });
    downloadHeaders(res, `${record.name}${record.extension}`, record.mime_type);
    stream.on("error", next);
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});

templatesRouter.post('/opportunities/:processId/annexes/:documentId/import',requireRole('owner','admin','analyst'),async(req,res,next)=>{
  try {
    if(!UUID_PATTERN.test(req.params.processId)||!UUID_PATTERN.test(req.params.documentId))return res.status(400).json({error:'Anexo no válido.'});
    const source=await query(`SELECT document_name,source_download_url,source_file_extension FROM saas.opportunity_documents
      WHERE id=$1 AND process_id=$2 AND organization_id=$3`,[req.params.documentId,req.params.processId,req.user.organization_id]);
    if(!source.rowCount)return res.status(404).json({error:'Anexo no encontrado.'});
    const doc=source.rows[0];let url=new URL(doc.source_download_url);
    let response;
    const signal=AbortSignal.timeout(20000);
    for(let hop=0;hop<4;hop++) {
      if(url.protocol!=='https:'||url.hostname!=='community.secop.gov.co'||url.port||url.username||url.password) throw Object.assign(new Error('La descarga automática solo admite el dominio oficial SECOP. Descarga el anexo desde la fuente y cárgalo aquí.'),{statusCode:422});
      response=await fetch(url,{redirect:'manual',signal});
      if(response.status>=300&&response.status<400){await response.body?.cancel();url=new URL(response.headers.get('location'),url);continue;}
      break;
    }
    if(!response?.ok) throw Object.assign(new Error('SECOP no permitió descargar el anexo. Descárgalo desde la fuente y cárgalo aquí.'),{statusCode:422});
    const chunks=[];let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>config.documentUploadMaxBytes)throw Object.assign(new Error('El anexo supera el límite de carga.'),{statusCode:413});chunks.push(chunk);}
    const type=String(doc.source_file_extension??'').replace(/^\./,'').toLowerCase();
    const filename=/\.(pdf|docx)$/i.test(doc.document_name)?doc.document_name:doc.document_name+'.'+(type||'pdf');
    req.templateUpload={buffer:Buffer.concat(chunks),metadata:{filename,name:doc.document_name,scope:'process',processId:req.params.processId,description:'Anexo del contratante importado desde SECOP II.'}};
    await saveUploadedTemplate(req,res,next);
  }catch(error){next(error);}
});

templatesRouter.post('/templates/:templateId/detect-fields',requireRole('owner','admin','analyst'),async(req,res,next)=>{try{
 const row=(await query('SELECT t.template_type,v.storage_key,v.file_hash_sha256 FROM saas.document_templates t JOIN saas.document_template_versions v ON v.template_id=t.id AND v.version_number=t.current_version WHERE t.id=$1 AND t.organization_id=$2',[req.params.templateId,req.user.organization_id])).rows[0];
 if(!row)return res.status(404).json({error:'Plantilla no encontrada.'});
 const buffer=await readStoredDocument(row.storage_key);if(fileSha256(buffer)!==row.file_hash_sha256)return res.status(409).json({error:'El original cambió. Vuelve a cargarlo.'});
 res.json({fields:await inspectTemplate(buffer,row.template_type)});
}catch(e){next(e);}});
