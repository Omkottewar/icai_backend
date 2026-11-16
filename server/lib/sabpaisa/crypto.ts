// SabPaisa encryption — "AES256HMACSHA384HEX", as published in SabPaisa's
// developer docs (https://developer.sabpaisa.in) and their official
// integration kits.
//
//   authKey  base64 → 32 raw bytes → AES-256-GCM key
//   authIV   base64 → raw bytes    → HMAC-SHA384 key (despite the name it
//                                   is NOT an IV — the GCM IV is random)
//
// Encrypt:
//   iv          = 12 random bytes
//   ct || tag   = AES-256-GCM(authKey, iv, plaintext)   (tag = 16 bytes)
//   message     = iv || ct || tag
//   hmac        = HMAC-SHA384(authIV, message)          (48 bytes)
//   output      = UPPERCASE HEX of (hmac || message)
//
// Decrypt is the reverse; the HMAC is checked (constant time) before any
// decryption, so a payload that wasn't produced with our keys is rejected.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const IV_SIZE = 12;
const TAG_SIZE = 16;
const HMAC_SIZE = 48;

export function decodeKey(b64: string, label: string): Buffer {
  const clean = (b64 ?? "").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) {
    throw new Error(`${label} must be the base64 string issued by SabPaisa`);
  }
  return Buffer.from(clean, "base64");
}

export function sabpaisaEncrypt(plaintext: string, authKey: string, authIv: string): string {
  const aesKey = decodeKey(authKey, "SABPAISA_AUTH_KEY");
  const hmacKey = decodeKey(authIv, "SABPAISA_AUTH_IV");
  if (aesKey.length !== 32) throw new Error(`SABPAISA_AUTH_KEY must decode to 32 bytes for AES-256 (got ${aesKey.length})`);

  const iv = randomBytes(IV_SIZE);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv, { authTagLength: TAG_SIZE });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const message = Buffer.concat([iv, ct, cipher.getAuthTag()]);
  const hmac = createHmac("sha384", hmacKey).update(message).digest();
  return Buffer.concat([hmac, message]).toString("hex").toUpperCase();
}

export function sabpaisaDecrypt(hexCipherText: string, authKey: string, authIv: string): string {
  const aesKey = decodeKey(authKey, "SABPAISA_AUTH_KEY");
  const hmacKey = decodeKey(authIv, "SABPAISA_AUTH_IV");

  const hex = (hexCipherText ?? "").trim();
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error("SabPaisa payload is not hex");
  }
  const full = Buffer.from(hex, "hex");
  if (full.length < HMAC_SIZE + IV_SIZE + TAG_SIZE) {
    throw new Error("SabPaisa payload too short");
  }

  const hmacReceived = full.subarray(0, HMAC_SIZE);
  const message = full.subarray(HMAC_SIZE);
  const hmacExpected = createHmac("sha384", hmacKey).update(message).digest();
  if (!timingSafeEqual(hmacReceived, hmacExpected)) {
    throw new Error("SabPaisa HMAC check failed — payload tampered or wrong keys");
  }

  const iv = message.subarray(0, IV_SIZE);
  const tag = message.subarray(message.length - TAG_SIZE);
  const ct = message.subarray(IV_SIZE, message.length - TAG_SIZE);
  const decipher = createDecipheriv("aes-256-gcm", aesKey, iv, { authTagLength: TAG_SIZE });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
