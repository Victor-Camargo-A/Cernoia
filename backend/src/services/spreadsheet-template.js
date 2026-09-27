import PizZip from 'pizzip';
import {escapeXml,suggestContext} from './annex-fields.js';
const textOf=s=>s.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
export function inspectSpreadsheet(buffer){
 const zip=new PizZip(buffer);const shared=[...(zip.file('xl/sharedStrings.xml')?.asText()??'').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m=>textOf(m[1]));const fields=[];
 for(const [path,file] of Object.entries(zip.files).filter(([p,f])=>!f.dir&&/^xl\/worksheets\/sheet\d+\.xml$/.test(p))){let previous='';for(const match of file.asText().matchAll(/<c\b([^>]*\br="([A-Z]+\d+)"[^>]*)>([\s\S]*?)<\/c>/g)){
  const value=/\bt="s"/.test(match[1])?shared[Number(match[3].match(/<v>(.*?)<\/v>/)?.[1])]??'':textOf(match[3]);
  if(/\{\{?[a-zA-Z0-9_.-]+\}?\}|_{3,}/.test(value)&&!/<f\b/.test(match[3])){const token=value.match(/\{\{?([a-zA-Z0-9_.-]+)\}?\}/)?.[1];const label=value.replace(/_{3,}/g,'').trim()||previous||match[2];fields.push({name:`xlsx_${path.match(/sheet(\d+)/)[1]}_${match[2]}`,label,type:'xlsx_cell',required:true,sheet:path,cell:match[2],suggested_source:token||suggestContext(label)});}
  if(value.trim())previous=value.slice(-160);
 }}return fields.slice(0,300);
}
export function renderSpreadsheet(buffer,fields,values,mapping,issues){
 const zip=new PizZip(buffer);
 for(const field of fields){if(field.type!=='xlsx_cell'||!/^xl\/worksheets\/sheet\d+\.xml$/.test(field.sheet??'')||!/^\$?[A-Z]{1,3}\$?[1-9]\d{0,6}$/.test(field.cell??'')){issues.push({field:field.name,code:'invalid_position'});continue;}
  const value=values[mapping[field.name]??field.name];if(value==null||!String(value).trim()){issues.push({field:field.name,code:'required_value_missing'});continue;}
  const file=zip.file(field.sheet);if(!file){issues.push({field:field.name,code:'invalid_position'});continue;}
  const cell=field.cell.replace(/\$/g,'');const pattern=new RegExp(`<c\\b([^>]*\\br="${cell}"[^>]*)(?:>([\\s\\S]*?)<\\/c>|\\s*\\/>)`);let changed=false;
  const xml=file.asText().replace(pattern,(_all,attributes,content='')=>{if(/<f\b/.test(content)){issues.push({field:field.name,code:'formula_cell_protected'});return _all;}changed=true;const attrs=attributes.replace(/\s+t="[^"]*"/,'').replace(/\/$/,'');return `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;});
  if(!changed)issues.push({field:field.name,code:'invalid_position'});zip.file(field.sheet,xml);
 }
 return {buffer:zip.generate({type:'nodebuffer',compression:'DEFLATE'}),mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',extension:'.xlsx',issues};
}
