import {addDocxSignature} from './template-signature.js';
import {inspectPdfBlanks} from "./pdf-annex-fields.js";
import {inspectSpreadsheet,renderSpreadsheet} from "./spreadsheet-template.js";
import { inspectDocxBlanks, fillDocxBlanks } from "./annex-fields.js";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
} from "pdf-lib";

const FIELD_PATTERN = /^[a-zA-Z0-9_.-]{1,120}$/;

export async function inspectTemplate(buffer, templateType) {
  if(templateType === "xlsx") return inspectSpreadsheet(buffer);
  if (templateType === "docx") {
    const zip = new PizZip(buffer);
    const xml = Object.entries(zip.files)
      .filter(([name, file]) => !file.dir && /^word\/.+\.xml$/i.test(name))
      .map(([, file]) => file.asText())
      .join("\n")
      .replace(/<[^>]+>/g, "");
    const names = new Set();
    for (const match of xml.matchAll(/\{\{?\s*([a-zA-Z0-9_.-]{1,120})\s*\}?\}/g)) names.add(match[1]);
    return [...names].map((name) => ({ name, type: "text", required: true })).concat(inspectDocxBlanks(zip.file("word/document.xml")?.asText() ?? ""));
  }
  const pdf = await PDFDocument.load(buffer, { ignoreEncryption: false });
  const fields=pdf.getForm().getFields().map((field) => ({
    name: field.getName(),
    type: field.constructor.name.replace(/^PDF/, "").toLowerCase(),
    required: field.isRequired(),
  }));
  return fields.length?fields:inspectPdfBlanks(buffer);
}

function safeValues(values) {
  return Object.fromEntries(
    Object.entries(values ?? {})
      .filter(([key]) => FIELD_PATTERN.test(key) && !["__proto__","constructor","prototype"].includes(key))
      .slice(0, 300)
      .map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : value ?? ""]),
  );
}

export async function renderTemplate({ buffer, templateType, values, mapping = {}, fieldSchema = [], signature = null }) {
  const context = safeValues(values);
  const issues = [];
  const signFields=fieldSchema.filter(f=>(mapping[f.name]??f.suggested_source)==='signature_image'||f.type==='docx_signature'||f.type==='signature');
  const signNames=new Set(signFields.map(f=>f.name));
  if(signature&&!signFields.length)throw Object.assign(Error('Selecciona el campo de firma antes de generar el anexo firmado.'),{statusCode:422});
  for(const field of signFields)if(!signature)issues.push({field:field.name,code:'signature_missing'});

  if(!fieldSchema.length) issues.push({field:"document",code:"no_fillable_fields"});
  for (const field of fieldSchema) {
    const mappedKey = mapping[field.name] ?? field.name;
    if (!signNames.has(field.name) && field.required && !String(context[mappedKey] ?? "").trim()) {
      issues.push({ field: field.name, code: "required_value_missing" });
    }
  }

  if(templateType==='xlsx'&&signature)throw Object.assign(Error('Para firmar este Excel, utiliza su versión PDF con un campo de firma.'),{statusCode:422});
  if(templateType === "xlsx") return renderSpreadsheet(buffer,fieldSchema,context,mapping,issues);
  if (templateType === "docx") {
    const zip = new PizZip(buffer);
    const main=zip.file('word/document.xml');
    const tokens=[],signContext={...context},signMapping={...mapping};
    for(const [index,f] of signFields.entries())if(f.type!=='docx_signature'&&signature){const token=`CERNOIASIGNATURETOKEN${index}END`;tokens.push(token);signContext[f.name]=token;signMapping[f.name]=f.name;}
    const textFields=fieldSchema.filter(f=>!signNames.has(f.name)||signature&&f.type!=='docx_signature');
    if(main) zip.file('word/document.xml',fillDocxBlanks(main.asText(),textFields,signContext,signMapping,issues));
    if(fieldSchema.some(f=>['docx_blank','docx_placeholder'].includes(f.type))) issues.push({field:'document',code:'review_official_annex'});
    const document = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => "",
    });
    const mappedContext = { ...context };
    for (const [templateField, sourceField] of Object.entries(mapping ?? {})) {
      if (FIELD_PATTERN.test(templateField)) mappedContext[templateField] = context[sourceField] ?? "";
    }
    for(const f of signFields)if(signature&&f.type==='text')mappedContext[f.name]=signContext[f.name];
    document.render(mappedContext);
    if(signature)await addDocxSignature(document.getZip(),signature,tokens,signFields.filter(f=>f.type==='docx_signature'));

    return {
      buffer: document.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      extension: ".docx",
      issues,
    };
  }

  const pdf = await PDFDocument.load(buffer, { ignoreEncryption: false });
  const form = pdf.getForm();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const field of form.getFields()) {
    const fieldName = field.getName();
    if(signNames.has(fieldName))continue;
    const sourceName = mapping[fieldName] ?? fieldName;
    const rawValue = context[sourceName];
    if (rawValue == null || rawValue === "") continue;
    try {
      if (field instanceof PDFTextField) field.setText(String(rawValue).slice(0, 5000));
      else if (field instanceof PDFCheckBox) {
        if ([true, "true", "1", "yes", "si", "sí"].includes(rawValue)) field.check();
        else field.uncheck();
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup) {
        field.select(String(rawValue));
      }
    } catch {
      issues.push({ field: fieldName, code: "value_not_accepted" });
    }
  }
  for(const field of fieldSchema.filter(f=>f.type==='pdf_overlay'&&!signNames.has(f.name))) {
    const page=pdf.getPages()[Number(field.page)-1];
    const value=context[mapping[field.name]??field.name];
    const x=Number(field.x),y=Number(field.y),size=Number(field.font_size??10);
    const width=Number(field.max_width??(page?page.getWidth()-x-10:0));
    if(!page||!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>page.getWidth()||y>page.getHeight()||size<6||size>30) {issues.push({field:field.name,code:'invalid_position'});continue;}
    if(value==null||!String(value).trim()) {issues.push({field:field.name,code:'required_value_missing'});continue;}
    try {if(!Number.isFinite(width)||width<=0||font.widthOfTextAtSize(String(value),size)>width){issues.push({field:field.name,code:'value_overflows_field'});continue;}page.drawText(String(value).slice(0,1000),{x,y:page.getHeight()-y,font,size,maxWidth:width});}
    catch{issues.push({field:field.name,code:'value_not_accepted'});}
    issues.push({field:field.name,code:'review_overlay_position'});
  }
  if(signature){
    const image=signature.mime==='image/png'?await pdf.embedPng(signature.buffer):await pdf.embedJpg(signature.buffer);
    for(const f of signFields){
      let page=pdf.getPages()[Number(f.page)-1],x=Number(f.x),y=Number(f.y),width=Number(f.max_width??150),height=45;
      if(f.type==='signature'){const widget=form.getField(f.name).acroField.getWidgets()[0],rect=widget?.getRectangle();page=pdf.getPages().find(p=>p.ref.toString()===widget?.P()?.toString());if(rect&&page){x=rect.x;y=page.getHeight()-rect.y-rect.height;width=rect.width;height=rect.height;}}
      if(!page||![x,y,width,height].every(Number.isFinite)||x<0||y<0||width<=0||x+width>page.getWidth()||y+height>page.getHeight())throw Object.assign(Error('Revisa la posición del campo de firma.'),{statusCode:422});
      const scale=Math.min(width/image.width,height/image.height);page.drawImage(image,{x,y:page.getHeight()-y-image.height*scale,width:image.width*scale,height:image.height*scale});
    }
    issues.push({field:'signature',code:'review_overlay_position'});
  }
  form.updateFieldAppearances(font);
  return {
    buffer: Buffer.from(await pdf.save()),
    mimeType: "application/pdf",
    extension: ".pdf",
    issues,
  };
}
