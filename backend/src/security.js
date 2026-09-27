import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password) {
  const validation = validatePassword(password);
  if (!validation.valid) throw new Error(validation.error);
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt}$${Buffer.from(derived).toString("hex")}`;
}

export async function verifyPassword(password, storedHash) {
  if (typeof password !== "string" || password.length > 256) return false;
  const [algorithm, salt, expectedHex] = String(storedHash ?? "").split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(await scrypt(password, salt, expected.length));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < 12) {
    return { valid: false, error: "La contraseña debe tener al menos 12 caracteres." };
  }
  if (password.length > 256) {
    return { valid: false, error: "La contraseña supera el máximo permitido." };
  }
  if (!/[a-záéíóúñ]/i.test(password) || !/\d/.test(password)) {
    return { valid: false, error: "Usa una combinación de letras y números." };
  }
  return { valid: true, error: null };
}

export function createCsrfToken() {
  return randomBytes(32).toString("base64url");
}

export function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function signWebhookPayload(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
