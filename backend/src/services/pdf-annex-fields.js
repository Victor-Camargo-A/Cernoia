import {spawn} from 'node:child_process';
import {suggestContext} from './annex-fields.js';
export async function inspectPdfBlanks(buffer){
 const xml=await new Promise((resolve,reject)=>{const p=spawn('pdftotext',['-bbox','-','-'],{stdio:['pipe','pipe','ignore'],shell:false});const chunks=[];let size=0;const timer=setTimeout(()=>p.kill('SIGKILL'),30000);p.stdout.on('data',c=>{size+=c.length;if(size>8*1024*1024)p.kill('SIGKILL');else chunks.push(c);});p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(chunks).toString()):reject(Error('No se pudieron localizar campos PDF.'));});p.stdin.on('error',()=>{});p.stdin.end(buffer);}).catch(()=>null);
 if(!xml)return [];const fields=[];let page=0;
 for(const match of xml.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/g)){page++;let previous='';for(const word of match[1].matchAll(/<word\s+xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)"[^>]*>([\s\S]*?)<\/word>/g)){
  const value=word[5].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  const label=previous.slice(-120),source=suggestContext(label);
  if(/^_{3,}$/.test(value)&&source){fields.push({name:`pdf_blank_${page}_${fields.length}`,label,type:'pdf_overlay',required:true,page,x:Number(word[1]),y:Number(word[4])-2,font_size:10,max_width:Number(word[3])-Number(word[1]),suggested_source:source});previous='';}else previous=(previous+' '+value).slice(-140);
 }}return fields.slice(0,300);
}
