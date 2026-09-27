export const annexText=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
export function annexRole(name,archiveName){const t=annexText(name);
 if(archiveName&&annexRole(archiveName)==='informative'&&!/\b(formato|modelo)\b/.test(t))return 'informative';
 if(/\b(cdp|cdb|crp)\b|disponibilidad presupuestal|estudios? previos?|analisis del sector|invitacion|pliego|anexo tecnico|registro de proyecto|soportes tecnicos|minuta/.test(t))return 'informative';
 if(/\b(anexo|anexos|formato|formulario|modelo|carta|autorizacion|declaracion)\b|multas.*sanciones|tratamiento.*datos personales|oferta economica/.test(t))return 'fillable';
 if(/\bcertificado\b/.test(t))return 'informative';
 return 'unknown';
}
export function matchingAnnexes(requirement,entries){
 const stop=new Set('el la los las de del para por con un una y o que se al en anexo anexos formato formulario modelo proponente debera diligenciar firmado representante legal presentar documento nombre'.split(' '));
 const tokens=s=>new Set(annexText(s).split(' ').filter(w=>w.length>3&&!stop.has(w)&&!/^\d+$/.test(w)));
 const wanted=tokens([requirement.requirement_name,requirement.requirement_description,requirement.condition_text].filter(Boolean).join(' '));
 return entries.filter(e=>e.role==='fillable').map(e=>{const words=tokens(e.filename);const shared=[...words].filter(w=>wanted.has(w));return {entry:e,score:shared.length/Math.max(1,words.size),count:shared.length};}).filter(m=>m.count>=2&&m.score>=0.5).sort((a,b)=>b.score-a.score).map(m=>m.entry.id);
}
