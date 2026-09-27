import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mammoth from "mammoth";
import PizZip from "pizzip";
import { PDFDocument } from "pdf-lib";
import { config } from "../config.js";

const TEXT_LIMIT = 1_000_000;

function imageDimensions(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

function assertOcrImageSize(buffer) {
  const dimensions = imageDimensions(buffer);
  if (dimensions && dimensions.width * dimensions.height > config.ocrMaxImagePixels) {
    const error = new Error("La imagen supera el tamaño máximo permitido para OCR.");
    error.code = "OCR_IMAGE_TOO_LARGE";
    error.statusCode = 422;
    throw error;
  }
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, TEXT_LIMIT);
}

async function recognizeImage(buffer) {
  const tsv = (await runBinary("tesseract", ["stdin", "stdout", "-l", config.ocrLanguage, "tsv"], buffer, 180_000)).toString("utf8");
  const lines = new Map(), confidences = [];
  for (const row of tsv.split("\n").slice(1)) {
    const cells = row.split("\t");
    if (cells[0] !== "5" || cells.length < 12) continue;
    const word = cells.slice(11).join("\t").trim();
    if (!word) continue;
    const key = cells.slice(1, 5).join(":");
    lines.set(key, [...(lines.get(key) ?? []), word]);
    const confidence = Number(cells[10]);
    if (Number.isFinite(confidence) && confidence >= 0) confidences.push(confidence);
  }
  return { data: { text: [...lines.values()].map(words => words.join(" ")).join("\n"),
    confidence: confidences.length ? confidences.reduce((a,b) => a+b,0) / confidences.length : undefined } };
}

function runBinary(command, args, input = null, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, env: {...process.env, OMP_THREAD_LIMIT: "1"}, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= 4 * 1024 * 1024) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) return resolve(Buffer.concat(stdout));
      const error = new Error(`${command} terminó con código ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`);
      error.code = !timedOut && ["SIGINT","SIGTERM"].includes(signal) ? "DOCUMENT_CONVERSION_INTERRUPTED" : "DOCUMENT_CONVERSION_FAILED";
      if (error.code === "DOCUMENT_CONVERSION_INTERRUPTED") error.message = "La lectura fue interrumpida durante una actualización y se reintentará.";
      else if (timedOut) error.message = `${command} superó el tiempo de conversión permitido.`;
      reject(error);
    });
    if (input) { child.stdin.on("error", () => {}); child.stdin.end(input); }
  });
}

async function extractPdf(buffer, {requireCompletePdf=false,forceOcr=false} = {}) {
  let text = "", pageTexts = [];
  try {
    const raw = await runBinary("pdftotext", ["-layout", "-", "-"], buffer);
    pageTexts = String(raw).split("\f").map(cleanText);
    text = cleanText(raw);
  } catch {
    text = "";
  }
  const pageCount = requireCompletePdf ? (await PDFDocument.load(buffer)).getPageCount() : null;
  const allPagesHaveText = !requireCompletePdf || (pageTexts.length >= pageCount && pageTexts.slice(0,pageCount).every(t=>t.length>=40));
  if (text.length >= 80 && !forceOcr && allPagesHaveText) return { text, method: "pdftotext", ocrStatus: "not_needed", confidence: null, ...(requireCompletePdf ? {pageCount,processedPages:pageCount} : {}) };
  if (!config.ocrEnabled) {
    return { text, method: text ? "pdftotext_partial" : "none", ocrStatus: "not_configured", confidence: null };
  }

  const totalPages = pageCount ?? (await PDFDocument.load(buffer)).getPageCount();
  const ocrPages = requireCompletePdf && !forceOcr ? Array.from({length:totalPages},(_,i)=>i).filter(i=>(pageTexts[i]??"").length<40).length : totalPages;
  if (requireCompletePdf && ocrPages > config.publicOcrMaxPages) {
    throw Object.assign(new Error(`El PDF tiene ${ocrPages} páginas que necesitan OCR y supera el límite de lectura completa de ${config.publicOcrMaxPages}. Requiere revisión.`), {permanent:true});
  }
  const pagesToRead = requireCompletePdf ? totalPages : Math.min(totalPages,config.ocrMaxPages);

  const directory = await mkdtemp(join(tmpdir(), "cernoia-ocr-"));
  try {
    const pdfPath = join(directory, "source.pdf");
    const pagePrefix = join(directory, "page");
    await writeFile(pdfPath, buffer, { mode: 0o600 });
    const texts = [];
    const confidences = [];
    for (let page = 1; page <= pagesToRead; page++) {
      if(requireCompletePdf && !forceOcr && (pageTexts[page-1]??"").length>=40){texts.push(pageTexts[page-1]);continue;}
      await runBinary("pdftoppm", ["-f",String(page),"-l",String(page),"-singlefile","-r","160","-png",pdfPath,pagePrefix],null,180_000);
      const pageBuffer = await readFile(pagePrefix + '.png');
      assertOcrImageSize(pageBuffer);
      const result = await recognizeImage(pageBuffer);
      texts.push(result.data?.text ?? "");
      if (Number.isFinite(result.data?.confidence)) confidences.push(Number(result.data.confidence));
      await rm(pagePrefix + '.png');
    }
    return {
      text: cleanText(texts.join("\n\n")),
      method: "tesseract_pdf",
      ocrStatus: pagesToRead === totalPages ? "completed" : "partial",
      pageCount:totalPages,
      processedPages: pagesToRead,
      confidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length / 100 : null,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function extractImage(buffer) {
  if (!config.ocrEnabled) return { text: "", method: "none", ocrStatus: "not_configured", confidence: null };
  assertOcrImageSize(buffer);
  const result = await recognizeImage(buffer);
  return {
    text: cleanText(result.data?.text),
    method: "tesseract_image",
    ocrStatus: "completed",
    confidence: Number.isFinite(result.data?.confidence) ? Number(result.data.confidence) / 100 : null,
  };
}

async function extractSpreadsheet(buffer, {requireCompleteOffice=false}={}) {
  const workbook = new PizZip(buffer);
  const sharedXml = workbook.file("xl/sharedStrings.xml")?.asText() ?? "";
  const sharedStrings = [...sharedXml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/gi)].map((match) => cleanText(
    match[1].replace(/<[^>]+>/g, " "),
  ));
  if(requireCompleteOffice){let total=0;const sheets=Object.entries(workbook.files).filter(([name,file])=>!file.dir&&/^xl\/worksheets\/sheet\d+\.xml$/i.test(name));if(sheets.length>20)throw Object.assign(Error('El libro supera 20 hojas; no se marcará como lectura completa.'),{permanent:true});for(const [,file] of Object.entries(workbook.files)){total+=file._data?.uncompressedSize??0;if(total>80*1024*1024)throw Object.assign(Error('El libro supera 80 MB descomprimidos.'),{permanent:true});}for(const [,file] of sheets){const xml=file.asText();if(xml.length>8*1024*1024||[...xml.matchAll(/<row\b/g)].length>3000||[...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/gi)].some(row=>[...row[1].matchAll(/<c\b/g)].length>100))throw Object.assign(Error('El libro excede los límites de lectura completa; requiere revisión.'),{permanent:true});}}
  const lines = [];
  Object.entries(workbook.files)
    .filter(([name, file]) => !file.dir && /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .slice(0, 20)
    .forEach(([name, file]) => {
      lines.push(`HOJA: ${name}`);
      const xml = file.asText().slice(0, 8 * 1024 * 1024);
      const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/gi)].slice(0, 3000);
      for (const row of rows) {
        const cells = [...row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/gi)].slice(0, 100);
        const values = cells.map((cell) => {
          const raw = cell[2].match(/<v[^>]*>([\s\S]*?)<\/v>/i)?.[1]
            ?? cell[2].match(/<t[^>]*>([\s\S]*?)<\/t>/i)?.[1]
            ?? "";
          if (/\bt=["']s["']/i.test(cell[1])) return sharedStrings[Number(raw)] ?? "";
          return raw.replace(/<[^>]+>/g, " ");
        });
        lines.push(values.join(" | "));
        if (lines.length >= 60_000) break;
      }
    });
  return { text: cleanText(lines.join("\n")), method: "xlsx_xml", ocrStatus: "not_needed", confidence: null };
}

export async function extractDocumentText(buffer, { mimeType, filename, requireCompletePdf=false, requireCompleteOffice=false, forceOcr=false }) {
  const lowerName = String(filename ?? "").toLowerCase();
  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) return extractPdf(buffer,{requireCompletePdf,forceOcr});
  if (mimeType === "image/png" || mimeType === "image/jpeg" || /\.(png|jpe?g)$/.test(lowerName)) return extractImage(buffer);
  if (mimeType?.includes("wordprocessingml") || lowerName.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer });
    return { text: cleanText(result.value), method: "mammoth_docx", ocrStatus: "not_needed", confidence: null };
  }
  if (mimeType?.includes("spreadsheetml") || lowerName.endsWith(".xlsx")) return extractSpreadsheet(buffer,{requireCompleteOffice});
  return {
    text: "",
    method: "unsupported_legacy_format",
    ocrStatus: "requires_conversion",
    confidence: null,
    warning: "Los formatos .doc y .xls requieren conversión aislada a DOCX o XLSX.",
  };
}
