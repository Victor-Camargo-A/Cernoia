const unique=items=>[...new Set(items.filter(Boolean))];
const normal=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const current=f=>f.evidence_status==='document_supported'&&!f.conflict&&f.scope==='company';
const compact=value=>String(value??'').replace(/\s+/g,' ').trim();
const excerpt=value=>{const text=compact(value);return text.length>420?text.slice(0,417)+'…':text;};
export function enrichContractExperience(facts,documents){
 const docs=new Map(documents.map(d=>[d.id,d]));const enriched=[...facts];
 for(const fact of facts){
  if(fact.attribute!=='service'||fact.scope!=='company'||fact.evidence_kind!=='contract'||docs.get(fact.document_id)?.document_type!=='contract')continue;
  if(enriched.some(f=>f.document_id===fact.document_id&&['contracted_experience','completed_experience'].includes(f.attribute)))continue;
  enriched.push({...fact,id:fact.id+'-contract',dimension:'experience',attribute:'contracted_experience',label:'Experiencia contractual: '+fact.label,
   interpretation:'El contrato aportado documenta el compromiso de prestar este servicio. La terminación, entrega a satisfacción y experiencia ejecutada requieren su soporte correspondiente.',capability:''});
 }
 return enriched;
}
export function buildBusinessSummary(matrix,documents){
 const facts=matrix.facts??[],docs=new Map(documents.map(d=>[d.id,d]));
 const supported=facts.filter(current);
 const services=supported.filter(f=>f.attribute==='service');
 const contracted=facts.filter(f=>f.scope==='company'&&!f.conflict&&f.attribute==='contracted_experience');
 const completed=facts.filter(f=>f.scope==='company'&&!f.conflict&&f.attribute==='completed_experience');
 const companyNames=unique(facts.filter(f=>f.scope==='company'&&f.attribute==='legal_name'&&!f.conflict).map(f=>f.value));
 const sections=[];
 const section=(key,title,intro,rows)=>sections.push({key,title,paragraphs:[intro,...rows.slice(0,5).map(f=>`${f.label}: ${excerpt(f.value)}.${f.interpretation?' '+compact(f.interpretation):''}`)].filter(Boolean),sources:unique(rows.slice(0,5).map(f=>f.document_id)).map(id=>({document_id:id,name:docs.get(id)?.document_name??'Documento fuente'}))});
 section('identity','Identidad y actividad empresarial',companyNames.length?`${companyNames[0]} cuenta con ${documents.length} documentos aportados. La siguiente lectura integra la información extraída por IA y conserva el alcance de cada soporte.`:'La documentación aportada permite construir el siguiente perfil. La identidad empresarial aún necesita confirmarse con sus soportes.',facts.filter(f=>['legal_representative','registration'].includes(f.attribute)&&['company','representative'].includes(f.scope)&&!f.conflict).slice(0,3));
 section('services','Servicios y oportunidades afines',services.length?'Estos son los servicios descritos por los documentos de la empresa:':'Aún no hay servicios respaldados con evidencia suficiente. Los servicios declarados en el perfil se muestran junto a este resumen.',services);
 section('experience','Experiencia contractual y ejecución',`${unique(contracted.map(f=>f.document_id)).length} contratos aportados y ${unique(completed.map(f=>f.document_id)).length} soportes de ejecución identificados. Un servicio de gestión precontractual sí puede figurar como antecedente contractual; su objeto no lo convierte en una obra ejecutada.`,[...contracted,...completed]);
 const finances=supported.filter(f=>f.dimension==='financial'&&docs.get(f.document_id)?.document_type==='financial_statement');
 section('financial','Información financiera',finances.length?'Los soportes financieros permiten revisar los siguientes datos, respetando sus períodos:':'No se ha identificado información financiera suficiente para calcular un límite de contratación. El precio de un contrato no equivale a capacidad financiera ni a un monto máximo habilitado.',finances);
 const people=facts.filter(f=>f.dimension==='people'&&!f.conflict);
 section('people','Equipo y cualificaciones',people.length?'Las siguientes cualificaciones aparecen en los soportes. Cuando pertenecen a una persona, su vinculación con la empresa debe acreditarse por separado.':'La matriz todavía no permite confirmar un equipo vinculado con todas sus cualificaciones.',people.slice(0,3));
 const missing=matrix.missing_dimensions??[];
 section('next','Documentos y próximos pasos',[contracted.length&&!completed.length?'Para acreditar ejecución, aporta certificados de experiencia o actas de recibo/liquidación vinculados a los contratos.':'',facts.some(f=>f.evidence_status==='expired')?'Hay soportes vencidos que deben revisarse antes de una postulación.':'',matrix.conflicts?.length?'Hay datos contradictorios que requieren aclaración.':'',missing.length?'Información por completar: '+missing.map(d=>d.label).join(', ')+'.':''].filter(Boolean).join(' '),[]);
 const positiveText=normal(services.map(f=>[f.label,f.capability].filter(Boolean).join(' ')).join(' '));
 const types=[];if(services.length)types.push('Prestación de servicios');
 const technical=/consultor|diagnostic|estudio|gestion tecnica|diseno|asesor/.test(positiveText);
 if(technical)types.push('Consultoría');
 if(/suministr|venta de|comercializacion/.test(positiveText))types.push('Suministros');
 if(/construccion|ejecucion de obra/.test(positiveText))types.push('Obra');
 const methods=[{name:'Mínima cuantía',basis:'Punto de partida de la búsqueda. Cada invitación define sus requisitos.',document_ids:[]}];
 if(technical)methods.push({name:'Concurso de méritos abierto',basis:'Los servicios técnicos o de consultoría documentados permiten explorar esta modalidad. Deben revisarse la experiencia, el equipo y los requisitos de cada proceso.',document_ids:unique(services.map(f=>f.document_id))});
 const hasRup=documents.some(d=>d.document_type==='rup'&&d.review_status!=='rejected'&&(!d.expiration_date||(d.expiration_date instanceof Date?d.expiration_date.toISOString():String(d.expiration_date)).slice(0,10)>=new Date().toISOString().slice(0,10)));
 if(hasRup&&finances.length&&completed.some(current))for(const name of ['Selección Abreviada de Menor Cuantía','Licitación pública'])methods.push({name,basis:'Se identificaron RUP, información financiera y experiencia ejecutada. Estos soportes permiten ampliar la búsqueda; la habilitación depende de los requisitos concretos.',document_ids:unique([...finances,...completed].map(f=>f.document_id))});
 return {title:'Resumen empresarial basado en tus documentos',sections,contracted_documents:unique(contracted.map(f=>f.document_id)).length,completed_documents:unique(completed.map(f=>f.document_id)).length,
 recommendations:{contract_types:unique(types),procurement_methods:methods,default_filters:{procurement_methods:['Mínima cuantía'],process_statuses:['Publicado'],only_open:true},can_expand:methods.length>1,
 message:methods.length>1?'La documentación permite explorar modalidades adicionales. Puedes agregarlas desde Configuración conservando mínima cuantía.':'La búsqueda comienza con mínima cuantía y estado publicado. Completa los soportes para evaluar otras modalidades.',
 limitation:'La afinidad documental orienta la búsqueda; la habilitación se verifica frente a cada invitación o pliego.',source_url:'https://www.colombiacompra.gov.co/archivos/manual/manual-para-determinar-y-verificar-los-requisitos-habilitantes-en-los-procesos-de-contratacion'}};
}
