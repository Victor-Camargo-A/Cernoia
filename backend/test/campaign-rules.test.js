import test from 'node:test';
import assert from 'node:assert/strict';
import PizZip from 'pizzip';
import {parseCsv,parseXlsx,importRows,campaignMail,smtpFailure} from '../src/services/campaign-rules.js';
process.env.DATABASE_URL??='postgres://unused:unused@localhost/unused';
const {feedbackReport}=await import('../src/services/campaign-feedback.js');

test('CSV español, saltos y comillas; duplicados normalizados y filas inválidas',()=>{
 const result=importRows(parseCsv('﻿Correo;Razón social\r\nUNO@EXAMPLE.COM;"Empresa; ""uno"""\r\nuno@example.com;Duplicada\r\nmal;Inválida'));
 assert.equal(result.contacts.length,1);assert.equal(result.contacts[0].email,'uno@example.com');assert.equal(result.duplicates,1);assert.equal(result.invalid_count,1);
 assert.deepEqual(parseCsv('email,empresa\na@example.com,"línea 1\nlínea 2"')[1],['a@example.com','línea 1\nlínea 2']);
 assert.throws(()=>parseCsv('email\n"sin cierre'));assert.throws(()=>importRows([['empresa'],['uno']]));
});
test('XLSX resuelve primera hoja, escapa XML e ignora fórmulas',()=>{
 const zip=new PizZip();zip.file('xl/workbook.xml','<workbook><sheets><sheet name="Lista" r:id="rId2"/></sheets></workbook>');zip.file('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>');
 zip.file('xl/worksheets/sheet2.xml','<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>correo</t></is></c><c r="B1" t="inlineStr"><is><t>empresa</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>uno@example.com</t></is></c><c r="B2" t="inlineStr"><is><t>A &amp; B</t></is></c></row><row><c r="A3"><f>HYPERLINK()</f><v>fake@example.com</v></c></row></sheetData></worksheet>');
 const rows=parseXlsx(zip.generate({type:'nodebuffer'}));assert.equal(rows.length,2);assert.equal(importRows(rows).contacts[0].company_name,'A & B');
 zip.file('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId2" Target="../secret"/></Relationships>');assert.throws(()=>parseXlsx(zip.generate({type:'nodebuffer'})));
});
test('El correo personaliza sin ejecutar HTML, incluye baja y un único destinatario',()=>{
 const mail=campaignMail({id:'id',email:'a@example.com',company_name:'<script>alert(1)</script>',subject:'Hola {empresa}',body_text:'Equipo {empresa}',cta_label:'Conocer',cta_url:'https://example.com',tracking_token:'token',track_opens:true,track_clicks:true,message_id:'<stable@example.com>'},{sender_name:'CernoIA',sender_email:'director@example.com'},'https://example.com');
 assert.ok(!mail.html.includes('<script>'));assert.ok(mail.html.includes('&lt;script&gt;'));assert.ok(mail.html.includes('/open/token.gif'));assert.ok(mail.text.includes('/unsubscribe/token'));assert.equal(mail.headers['List-Unsubscribe-Post'],'List-Unsubscribe=One-Click');assert.deepEqual(mail.envelope.to,['a@example.com']);assert.equal(mail.messageId,'<stable@example.com>');
});
test('Distingue rebote permanente, bloqueo, temporal, credenciales y resultado incierto',()=>{
 assert.equal(smtpFailure({responseCode:550,response:'550 5.1.1 User unknown'}).suppression,'hard_bounce');assert.equal(smtpFailure({responseCode:550,response:'550 5.7.1 policy rejected'}).status,'rejected');assert.equal(smtpFailure({responseCode:451}).status,'deferred');assert.equal(smtpFailure({code:'ETIMEDOUT'}).suppression,'uncertain');assert.equal(smtpFailure({code:'EAUTH',responseCode:535}).suppression,null);assert.equal(smtpFailure({code:'EAUTH'}).pause,true);assert.equal(smtpFailure({command:'MAIL FROM',responseCode:550}).suppression,null);assert.equal(smtpFailure({command:'DATA',responseCode:550,response:'Daily user sending limit exceeded'}).pause,true);
});
test('Correlaciona DSN y reportes sin confundir relay con entrega',()=>{
 const id='22222222-2222-4222-8222-222222222222';const prefix=`Original-Message-ID: <cernoia-campaign-${id}@example.com>\nFinal-Recipient: rfc822; a@example.com\n`;
 assert.equal(feedbackReport([prefix+'Action: failed\nStatus: 5.1.1']).type,'bounced');assert.equal(feedbackReport([prefix+'Action: failed\nStatus: 5.7.1']).type,'rejected');assert.equal(feedbackReport([prefix+'Action: delivered\nStatus: 2.0.0']).type,'delivered');assert.equal(feedbackReport([prefix+'Action: relayed\nStatus: 2.0.0']),null);assert.equal(feedbackReport(['Mensaje cualquiera']),null);assert.equal(feedbackReport([prefix+'Feedback-Type: abuse']).type,'complaint');
});
