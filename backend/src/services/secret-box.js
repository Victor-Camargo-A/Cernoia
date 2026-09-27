import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";

const KEY = Buffer.from(config.dataEncryptionKey, "hex");

export function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return {
    encrypted: encrypted.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptSecret({ encrypted, iv, tag }) {
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
