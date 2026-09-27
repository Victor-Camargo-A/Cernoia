// Detectar espacios explícitos en el DOCX sin reescribir el contenido contractual.
const unescapeXml=s=>s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
export const escapeXml=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
export function suggestContext(label) {
  const text=label.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if(/^firma(?:\s|$)/.test(text.trim())&&!/nombre|identific|cedula/.test(text))return 'signature_image';
  if(/^nombre.*representante|^representante(?: legal)?\s*:?[ ]*$/.test(text))return 'representative_name';
  if(/razon social|nombre.*empresa|nombre.*proponente/.test(text))return 'legal_name';
  if(/\bnit\b/.test(text))return 'tax_id';
  if(/^nombre.*representante|^representante(?: legal)?\s*:?[ ]*$/.test(text))return 'representative_name';
  if(/correo|e.?mail/.test(text))return 'representative_email';
  if(/referencia.*proceso|numero.*proceso/.test(text))return 'process_reference';
  if(/entidad contratante/.test(text))return 'entity_name';
  return '';
}
export function inspectDocxBlanks(xml) {
  const fields=[];let paragraph=0;
  for(const match of xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)) {
    let run=0;let previous='';
    for(const text of match[0].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)) {
      const content=unescapeXml(text[1]);
      for(const [blank,space] of [...content.matchAll(/_{3,}/g)].entries()) {
        const label=(previous+' '+content.slice(0,space.index)).trim().slice(-160)||`Campo ${fields.length+1}`;
        // Cada espacio conserva una posición distinta, incluso dentro del mismo fragmento.
        fields.push({name:`annex_${paragraph}_${run}${blank?'_'+blank:''}`,label,type:'docx_blank',required:true,paragraph,run,blank,suggested_source:suggestContext(label)});
      }
      previous=(previous+' '+content).slice(-160);run++;
    }
    const plain=[...match[0].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(m=>unescapeXml(m[1])).join('');
    for(const placeholder of plain.matchAll(/\[[^\[\]\r\n]{3,250}\]|\(día\/mes\/año\)/gi)){
      if(!/[a-záéíóúñ]/i.test(placeholder[0]))continue;
      const label=placeholder[0].replace(/^[[(]|[\])]$/g,'');
      fields.push({name:`placeholder_${paragraph}_${placeholder.index}`,label,type:'docx_placeholder',required:true,paragraph,start:placeholder.index,end:placeholder.index+placeholder[0].length,original:placeholder[0],suggested_source:/día\/mes\/año/i.test(label)?'date_today':suggestContext(label)});
    }
    paragraph++;
  }
  const paragraphs=[...xml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)].map(m=>unescapeXml(m[0].replace(/<[^>]+>/g,''))).map(s=>s.trim());
  for(let p=0;p<paragraphs.length;p++){
    if(!/^firma(?:\s|:|_|$)/i.test(paragraphs[p])||/nombre|identific|cedula|certific|digital|electronic/i.test(paragraphs[p]))continue;
    const blanks=fields.filter(f=>f.type==='docx_blank'&&(f.paragraph===p||f.paragraph===p-1&&/^_{3,}$/.test(paragraphs[p-1])));
    if(blanks.length===1){blanks[0].label=paragraphs[p];blanks[0].suggested_source='signature_image';}
    else if(!blanks.length)fields.push({name:`signature_${p}`,label:paragraphs[p],type:'docx_signature',required:true,paragraph:p,suggested_source:'signature_image'});
  }
  if(!fields.some(f=>f.suggested_source==='signature_image')&&/firmad[oa]|firma(?:r|nte)?/i.test(paragraphs.join(' '))){
    const closing=paragraphs.findIndex((text,i)=>/^(atentamente|cordialmente)[,.: ]*$/i.test(text)&&paragraphs.slice(i+1,i+7).some(t=>/representante|proponente/i.test(t)));
    if(closing>=0&&paragraphs[closing+1]==='')fields.push({name:`signature_${closing+1}`,label:'Firma del proponente (cierre del documento)',type:'docx_signature',required:true,paragraph:closing+1,suggested_source:'signature_image'});
  }
  return fields.slice(0,300);
}
export function fillDocxBlanks(xml,fields,values,mapping,issues) {
  let paragraph=0;
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g,part=>{
    let run=0;const p=paragraph++;
    // Replace only the recorded placeholder span, including placeholders split
    // across Word runs, keeping surrounding text and each run's formatting.
    const replacements=fields.filter(f=>f.type==='docx_placeholder'&&f.paragraph===p);
    const texts=[...part.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(m=>unescapeXml(m[1]));
    const plain=texts.join('');let offset=0;const active=[];
    for(const field of replacements){
      if(!Number.isInteger(field.start)||!Number.isInteger(field.end)||plain.slice(field.start,field.end)!==field.original){issues.push({field:field.name,code:'invalid_position'});continue;}
      const value=values[mapping[field.name]??field.name];
      if(value==null||!String(value).trim()){issues.push({field:field.name,code:'required_value_missing'});continue;}
      active.push({...field,value:String(value)});
    }
    if(active.length)part=part.replace(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g,(_all,start,content,end)=>{
      const text=unescapeXml(content),from=offset,to=offset+text.length;offset=to;let output=text;
      for(const field of active.filter(f=>f.start<to&&f.end>from).sort((a,b)=>b.start-a.start))output=output.slice(0,Math.max(0,field.start-from))+(field.start>=from?field.value:'')+output.slice(Math.min(text.length,field.end-from));
      return start+escapeXml(output)+end;
    });
    return part.replace(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g,(_all,start,content,end)=>{
      const r=run++;let blank=0;
      return start+content.replace(/_{3,}/g,space=>{
        const index=blank++;const field=fields.find(f=>f.type==='docx_blank'&&f.paragraph===p&&f.run===r&&(f.blank??0)===index);
        if(!field){issues.push({field:`annex_${p}_${r}_${index}`,code:'unmapped_blank'});return space;}
        const value=values[mapping[field.name]??field.name];
        if(value==null||!String(value).trim()){issues.push({field:field.name,code:'required_value_missing'});return space;}
        return escapeXml(value);
      })+end;
    });
  });
}
