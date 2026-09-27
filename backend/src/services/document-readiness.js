import { query } from '../db.js';

export const PROFILE_DOCUMENTS = [
  ['chamber_of_commerce', 'Certificado de Cámara de Comercio'],
  ['rut', 'Registro Único Tributario (RUT)'],
  ['experience_certificate', 'Certificados de experiencia relacionada'],
  ['financial_statement', 'Estados financieros'],
];

export function documentState(doc, now = new Date()) {
  if (!doc) return 'missing';
  if (doc.expiration_date && new Date(doc.expiration_date).toISOString().slice(0,10) < now.toISOString().slice(0,10)) return 'expired';
  if (['failed','needs_review'].includes(doc.extraction_status) || doc.review_status === 'rejected') return 'needs_review';
  if (!['extracted','success'].includes(doc.extraction_status)) return 'processing';
  if (!['approved','corrected'].includes(doc.review_status) && doc.verification_status !== 'verified') return 'pending_review';
  return 'available';
}

export async function documentReadiness(organizationId) {
  const result = await query(`SELECT id, document_type, document_name, expiration_date, extraction_status,
    review_status, verification_status, updated_at FROM saas.organization_documents
    WHERE organization_id=$1 AND document_status <> 'deleted' ORDER BY updated_at DESC`, [organizationId]);
  const documents = result.rows.map(doc => ({ ...doc, state: documentState(doc) }));
  return {
    documents,
    suggested: PROFILE_DOCUMENTS.map(([type, label]) => {
      const choices = documents.filter(doc => doc.document_type === type);
      const rank = ['available','pending_review','processing','needs_review','expired','missing'];
      const doc = choices.sort((a,b) => rank.indexOf(a.state)-rank.indexOf(b.state))[0];
      return { type, label, state: doc?.state ?? 'missing', document_id: doc?.id ?? null };
    }),
    note: 'Estos soportes ayudan a sustentar el perfil. Su obligatoriedad depende de los pliegos. Cargarlos no garantiza mayor afinidad ni cumplimiento; el reanálisis debe comprobar su contenido y vigencia.',
  };
}
