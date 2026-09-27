import PizZip from 'pizzip';import {extname} from 'node:path';import {PDFDocument} from 'pdf-lib';
import {extractDocumentText} from './document-extractor.js';import {validateUploadedFile} from './document-storage.js';import {scanForMalware} from './malware-scanner.js';import {config} from '../config.js';
export async function completePublicText(buffer,filename){
 const extension=extname(filename).toLowerCase();
 if(extension==='.zip'){
  const zip=new PizZip(buffer),entries=Object.entries(zip.files).filter(([,f])=>!f.dir);let bytes=0;const texts=[];
  if(entries.length>100)throw Object.assign(Error('El ZIP supera 100 archivos.'),{permanent:true});
  for(const [name,file] of entries){if(name.startsWith('/')||name.includes('\\')||name.split('/').includes('..')||/^[A-Za-z]:/.test(name)||(Number(file.unixPermissions)&0xf000)===0xa000)throw Object.assign(Error('El ZIP contiene rutas no admitidas.'),{permanent:true});
   const size=file._data?.uncompressedSize??0;bytes+=size;if(size>config.documentUploadMaxBytes||bytes>80*1024*1024)throw Object.assign(Error('El ZIP supera los límites de lectura.'),{permanent:true});
   if(name.startsWith('__MACOSX/')||name.endsWith('.DS_Store'))continue;
   if(extname(name).toLowerCase()==='.zip')throw Object.assign(Error('El expediente contiene ZIP anidados. Requiere revisión.'),{permanent:true});
   const part=file.asNodeBuffer();await scanForMalware(part);const result=await completePublicText(part,name);texts.push('ARCHIVO DEL ZIP: '+name+'\n'+result.text);
  }
  const text=texts.join('\n\n');if(text.length>=1000000)throw Object.assign(Error('El texto del ZIP supera el límite de lectura completa.'),{permanent:true});return {text,mime:'application/zip',extension};
 }
 // Macro-enabled spreadsheets are read as XML only. No macros or formulas run.
 const checkedName=extension==='.xlsm'?filename.replace(/\.xlsm$/i,'.xlsx'):filename;
 const validation=validateUploadedFile(buffer,checkedName);if(!validation.valid||!['.pdf','.docx','.xlsx'].includes(validation.extension))throw Object.assign(Error(`${filename}: formato pendiente de conversión para lectura completa.`),{permanent:true});
 const result=await extractDocumentText(buffer,{mimeType:validation.mime,filename:checkedName,requireCompletePdf:true,requireCompleteOffice:true});
 if(!result.text||result.text.length<40)throw Object.assign(Error(`${filename}: no se pudo extraer texto suficiente para una lectura completa.`),{permanent:true});
 if(validation.extension==='.pdf'&&(!['completed','not_needed'].includes(result.ocrStatus)||result.processedPages!==(await PDFDocument.load(buffer)).getPageCount()))throw Object.assign(Error('El OCR no terminó todas las páginas.'),{permanent:true});
 if(result.text.length>=1000000)throw Object.assign(Error('El documento supera el límite de lectura completa.'),{permanent:true});return {text:result.text,mime:validation.mime,extension};
}
