import {PDFDocument} from 'pdf-lib';
import {query} from '../db.js';
import {readStoredDocument,fileSha256} from './document-storage.js';
export const signatureField=f=>f.type==='docx_signature'||f.type==='signature'||f.suggested_source==='signature_image';
export async function authorizedTemplateSignature(user,input){
 if(input.include_signature!==true)return null;
 if(input.confirm_signature!==true)throw Object.assign(Error('Confirma el uso de tu firma en este documento.'),{statusCode:422});
 const row=(await query('SELECT * FROM saas.app_signature_profiles WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',[user.organization_id,user.id])).rows[0];
 if(!row)throw Object.assign(Error('Primero carga o dibuja tu firma.'),{statusCode:422});
 if(input.signature_profile_id!==row.id)throw Object.assign(Error('La firma cambió. Vuelve a seleccionarla y confirma su uso.'),{statusCode:409});
 const buffer=await readStoredDocument(row.storage_key);if(fileSha256(buffer)!==row.file_hash_sha256)throw Object.assign(Error('La firma guardada no supera la comprobación de integridad.'),{statusCode:409});
 return {buffer,mime:row.mime_type,id:row.id,hash:row.file_hash_sha256};
}
export async function signatureDimensions(signature){const pdf=await PDFDocument.create();const img=signature.mime==='image/png'?await pdf.embedPng(signature.buffer):await pdf.embedJpg(signature.buffer);const scale=Math.min(150/img.width,45/img.height);return {width:img.width*scale,height:img.height*scale};}
export async function addDocxSignature(zip,signature,tokens,standalone){
 if(!tokens.length&&!standalone.length)return;
 const ext=signature.mime==='image/png'?'png':'jpg',name=`cernoia-signature-${signature.hash}.${ext}`,id='cernoiaSignatureImage';
 zip.file('word/media/'+name,signature.buffer);
 const path='word/_rels/document.xml.rels';let rel=zip.file(path)?.asText()??'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
 if(rel.includes(`Id="${id}"`))throw Error('El documento ya contiene una firma insertada por CernoIA. Usa su original.');
 rel=rel.replace('</Relationships>',`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/></Relationships>`);zip.file(path,rel);
 const types=zip.file('[Content_Types].xml').asText();zip.file('[Content_Types].xml',types.replace('</Types>',`<Override PartName="/word/media/${name}" ContentType="${signature.mime}"/></Types>`));
 const {width,height}=await signatureDimensions(signature);let imageId=900000;
 const drawing=()=>`<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${Math.round(width*12700)}" cy="${Math.round(height*12700)}"/><wp:docPr id="${imageId++}" name="Firma del usuario"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="Firma"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(width*12700)}" cy="${Math.round(height*12700)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
 let xml=zip.file('word/document.xml').asText();
 for(const token of tokens){if(!xml.includes(token))throw Object.assign(Error('No se pudo ubicar el campo de firma en el original.'),{statusCode:422});xml=xml.replace(token,`</w:t>${drawing()}<w:t xml:space="preserve">`);}
 let paragraph=0;xml=xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g,part=>{const p=paragraph++;return standalone.some(f=>f.paragraph===p)?(/<w:r\b/.test(part)?part.replace(/(<w:r\b)/,`<w:r>${drawing()}<w:br/></w:r>$1`):part.replace('</w:p>',`<w:r>${drawing()}</w:r></w:p>`)):part;});
 zip.file('word/document.xml',xml);
}
