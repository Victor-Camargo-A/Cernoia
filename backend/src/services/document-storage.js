import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { config } from "../config.js";

const ALLOWED_TYPES = new Map([
  [".pdf", { mime: "application/pdf", signature: "pdf" }],
  [".doc", { mime: "application/msword", signature: "ole" }],
  [".docx", { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", signature: "zip" }],
  [".xls", { mime: "application/vnd.ms-excel", signature: "ole" }],
  [".xlsx", { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", signature: "zip" }],
  [".png", { mime: "image/png", signature: "png" }],
  [".jpg", { mime: "image/jpeg", signature: "jpeg" }],
  [".jpeg", { mime: "image/jpeg", signature: "jpeg" }],
]);

const ENCRYPTION_MAGIC = Buffer.from("CERNOIA1", "ascii");
const ENCRYPTION_IV_BYTES = 12;
const ENCRYPTION_TAG_BYTES = 16;
const ENCRYPTION_KEY = Buffer.from(config.dataEncryptionKey, "hex");

function encryptBuffer(buffer) {
  const iv = randomBytes(ENCRYPTION_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENCRYPTION_MAGIC, iv, tag, ciphertext]);
}

function decryptBuffer(buffer) {
  if (!buffer.subarray(0, ENCRYPTION_MAGIC.length).equals(ENCRYPTION_MAGIC)) return buffer;
  const minimum = ENCRYPTION_MAGIC.length + ENCRYPTION_IV_BYTES + ENCRYPTION_TAG_BYTES;
  if (buffer.length <= minimum) throw new Error("El archivo privado cifrado está incompleto.");
  const ivStart = ENCRYPTION_MAGIC.length;
  const tagStart = ivStart + ENCRYPTION_IV_BYTES;
  const dataStart = tagStart + ENCRYPTION_TAG_BYTES;
  const decipher = createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, buffer.subarray(ivStart, tagStart));
  decipher.setAuthTag(buffer.subarray(tagStart, dataStart));
  return Buffer.concat([decipher.update(buffer.subarray(dataStart)), decipher.final()]);
}

function hasSignature(buffer, signature) {
  if (signature === "pdf") return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (signature === "zip") return buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (signature === "ole") return buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  if (signature === "png") return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (signature === "jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  return false;
}

export function validateUploadedFile(buffer, originalName) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { valid: false, error: "Selecciona un archivo con contenido." };
  }
  const extension = extname(String(originalName ?? "")).toLowerCase();
  const type = ALLOWED_TYPES.get(extension);
  if (!type) {
    return { valid: false, error: "Formato no permitido. Usa PDF, Word, Excel, PNG o JPG." };
  }
  if (!hasSignature(buffer, type.signature)) {
    return { valid: false, error: "El contenido del archivo no coincide con su extensión." };
  }
  return { valid: true, extension, mime: type.mime };
}

export function fileSha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function storeDocument({ organizationId, documentId = randomUUID(), extension, buffer }) {
  const relativeKey = join(organizationId, `${documentId}${extension}`);
  const absolutePath = resolve(config.documentStoragePath, relativeKey);
  const root = resolve(config.documentStoragePath);
  if (!absolutePath.startsWith(`${root}${sep}`)) throw new Error("Ruta de almacenamiento no válida.");
  await mkdir(resolve(config.documentStoragePath, organizationId), { recursive: true, mode: 0o750 });
  await writeFile(absolutePath, encryptBuffer(buffer), { mode: 0o640, flag: "wx" });
  return { documentId, relativeKey, absolutePath, encryptionVersion: "aes-256-gcm-v1" };
}

export function resolveStoredDocument(storageKey) {
  const root = resolve(config.documentStoragePath);
  const absolutePath = resolve(root, String(storageKey ?? ""));
  if (!storageKey || !absolutePath.startsWith(`${root}${sep}`)) return null;
  return absolutePath;
}

export function streamStoredDocument(storageKey) {
  const path = resolveStoredDocument(storageKey);
  if (!path) return null;
  const output = new PassThrough();
  readFile(path)
    .then((buffer) => output.end(decryptBuffer(buffer)))
    .catch((error) => output.destroy(error));
  return output;
}

export async function readStoredDocument(storageKey) {
  const path = resolveStoredDocument(storageKey);
  if (!path) return null;
  return decryptBuffer(await readFile(path));
}

export async function removeStoredDocument(storageKey) {
  const path = resolveStoredDocument(storageKey);
  if (!path) return;
  await unlink(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}
