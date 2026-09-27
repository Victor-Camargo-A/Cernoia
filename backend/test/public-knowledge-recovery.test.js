import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {publicEvidenceSegments,groundPublicInsight,normalizeText,knowledgeFailureState} from '../src/services/process-knowledge-rules.js';
process.env.OCR_ENABLED='true';
process.env.OCR_MAX_PAGES='1';
process.env.PUBLIC_OCR_MAX_PAGES='2';
const {extractDocumentText}=await import('../src/services/document-extractor.js');
const {previewPage}=await import('../src/services/document-preview.js');

test('source references preserve literal capitalization, accents, whitespace and conditions',()=>{
 const source='DEPARTAMENTO DE POLICIA SUCRE\n\nEl oferente debe aportar garantía, salvo la excepción indicada en el pliego.\n'+ 'Texto documental verificable. '.repeat(65);
 const segments=publicEvidenceSegments(source);
 assert.equal(segments.map(s=>s.text).join(' '),normalizeText(source));
 const output={document_role:'informative',summary:'Requisitos',facts:[{category:'legal',label:'Garantía',evidence_start:0,evidence_end:1,value:'INVENTADO',quote:'Cita inventada'}]};
 const result=groundPublicInsight(output,source);
 assert.ok(normalizeText(source).includes(result.facts[0].quote));
 assert.equal(result.facts[0].value,result.facts[0].quote);
 assert.ok(result.facts[0].quote.includes('salvo la excepción'));
 const broad=groundPublicInsight({...output,facts:[{...output.facts[0],evidence_start:0,evidence_end:3}]},source);
 assert.equal(broad.facts.length,2);
 assert.equal(broad.facts.map(f=>f.quote).join(' '),segments.slice(0,4).map(s=>s.text).join(' '));
 assert.ok(broad.facts.every(f=>f.quote.length<=1500&&normalizeText(source).includes(f.quote)));
 assert.throws(()=>groundPublicInsight({...output,facts:Array(31).fill({...output.facts[0],evidence_start:0,evidence_end:3})},source),/demasiadas referencias/);
 for(const [start,end] of [[-1,0],[0,100],[2,1],['0',1],[0,0.5]]){
  assert.throws(()=>groundPublicInsight({...output,facts:[{...output.facts[0],evidence_start:start,evidence_end:end}]},source));
 }
});

test('native OCR reads a scanned PDF and returns confidence without a JS OCR worker',{timeout:60000},async()=>{
 const original=await PDFDocument.create();const page=original.addPage([595,842]);const font=await original.embedFont(StandardFonts.Helvetica);
 page.drawText('CERTIFICADO DE PRUEBA DOCUMENTAL',{x:40,y:740,size:20,font});
 page.drawText('El plazo de entrega es de treinta dias.',{x:40,y:690,size:18,font});
 const png=await previewPage(Buffer.from(await original.save()),1);
 const scanned=await PDFDocument.create();const img=await scanned.embedPng(png);
 scanned.addPage([595,842]).drawImage(img,{x:0,y:0,width:595,height:842});
 const result=await extractDocumentText(Buffer.from(await scanned.save()),{mimeType:'application/pdf',filename:'scan.pdf'});
 assert.equal(result.method,'tesseract_pdf');assert.match(result.text,/CERTIFICADO DE PRUEBA DOCUMENTAL/);assert.match(result.text,/treinta/);assert.ok(result.confidence>0.5);
 scanned.addPage([595,842]).drawImage(img,{x:0,y:0,width:595,height:842});
 const twoPages=Buffer.from(await scanned.save());
 const partial=await extractDocumentText(twoPages,{mimeType:'application/pdf',filename:'scan.pdf'});
 assert.equal(partial.ocrStatus,'partial');assert.equal(partial.processedPages,1);
 const complete=await extractDocumentText(twoPages,{mimeType:'application/pdf',filename:'scan.pdf',requireCompletePdf:true});
 assert.equal(complete.ocrStatus,'completed');assert.equal(complete.processedPages,2);
 assert.equal(complete.text.match(/CERTIFICADO DE PRUEBA DOCUMENTAL/g).length,2);
 scanned.addPage([595,842]).drawImage(img,{x:0,y:0,width:595,height:842});
 await assert.rejects(extractDocumentText(Buffer.from(await scanned.save()),{mimeType:'application/pdf',filename:'scan.pdf',requireCompletePdf:true}),e=>e.permanent===true&&/3 páginas/.test(e.message));
});

test('complete PDF reading includes scanned pages even when another page contains text',{timeout:60000},async()=>{
 const source=await PDFDocument.create();source.addPage([595,842]).drawText('ANEXO ESCANEADO: experiencia requerida',{x:40,y:700,size:19});
 const png=await previewPage(Buffer.from(await source.save()),1);
 const mixed=await PDFDocument.create();mixed.addPage([595,842]).drawText('Pliego de prueba con texto digital suficiente para evitar OCR global. Condiciones iniciales.',{x:30,y:740,size:10});
 const image=await mixed.embedPng(png);mixed.addPage([595,842]).drawImage(image,{x:0,y:0,width:595,height:842});
 const result=await extractDocumentText(Buffer.from(await mixed.save()),{mimeType:'application/pdf',filename:'mixed.pdf',requireCompletePdf:true});
 assert.match(result.text,/Condiciones iniciales/);assert.match(result.text,/ANEXO ESCANEADO/);assert.equal(result.processedPages,2);assert.equal(result.ocrStatus,'completed');
});

test("worker update interruptions do not consume document failure attempts",()=>{const result=knowledgeFailureState({code:"DOCUMENT_CONVERSION_INTERRUPTED"},2);assert.equal(result.status,"queued");assert.equal(result.attempts,2);});
