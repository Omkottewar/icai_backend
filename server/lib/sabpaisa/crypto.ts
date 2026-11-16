// SabPaisa encryption. Two schemes, picked automatically from the key:
//
// 1. Legacy AES-128-CBC — used when SABPAISA_AUTH_KEY is a 16-character
//    string (the keys SabPaisa issued to NBWRI; this is what worked before
//    the Razorpay switch).
//      • checkout encData : base64(ciphertext) + ":" + base64(random IV)
//      • API calls        : UPPERCASE hex, IV = SABPAISA_AUTH_IV (static)
//      • responses        : either of the above, or base64 with the static IV
//
// 2. AES256HMACSHA384HEX — SabPaisa's current docs, used when
//    SABPAISA_AUTH_KEY is base64 decoding to 32 bytes:
//      authKey → AES-256-GCM key, authIV → HMAC-SHA384 key
//      output  = HEX( HMAC(48) || IV(12) || ciphertext || tag(16) )

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type SabPaisaScheme = "legacy-aes128" | "aes256-hmac";
export type EncryptPurpose = "checkout" | "api";

export function schemeFor(authKey: string): SabPaisaScheme {
  const k = (authKey ?? "").trim();
  if (Buffer.byteLength(k, "utf8") === 16) return "legacy-aes128";
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(k) && Buffer.from(k, "base64").length === 32) return "aes256-hmac";
  throw new Error("SABPAISA_AUTH_KEY must be SabPaisa's 16-character key (AES-128) or base64 AES-256 key (32 bytes)");
}

export function sabpaisaEncrypt(plaintext: string, authKey: string, authIv: string, purpose: EncryptPurpose = "checkout"): string {
  if (schemeFor(authKey) === "legacy-aes128") {
    const key = Buffer.from(authKey.trim(), "utf8");
    if (purpose === "api") {
      const c = createCipheriv("aes-128-cbc", key, staticIv(authIv));
      return Buffer.concat([c.update(plaintext, "utf8"), c.final()]).toString("hex").toUpperCase();
    }
    const iv = randomBytes(16);
    const c = createCipheriv("aes-128-cbc", key, iv);
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return `${ct.toString("base64")}:${iv.toString("base64")}`;
  }

  const aesKey = Buffer.from(authKey.trim(), "base64");
  const hmacKey = Buffer.from(authIv.trim(), "base64");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", aesKey, iv, { authTagLength: 16 });
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const message = Buffer.concat([iv, ct, c.getAuthTag()]);
  const hmac = createHmac("sha384", hmacKey).update(message).digest();
  return Buffer.concat([hmac, message]).toString("hex").toUpperCase();
}

export function sabpaisaDecrypt(payload: string, authKey: string, authIv: string): string {
  const raw = (payload ?? "").trim();
  if (!raw) throw new Error("SabPaisa payload is empty");

  if (schemeFor(authKey) === "legacy-aes128") {
    const key = Buffer.from(authKey.trim(), "utf8");
    const s = raw.replace(/ /g, "+");
    const colon = s.indexOf(":");
    if (colon > 0) {
      const iv = Buffer.from(s.slice(colon + 1), "base64");
      if (iv.length !== 16) throw new Error("SabPaisa payload IV is not 16 bytes");
      return aes128Decrypt(key, iv, Buffer.from(s.slice(0, colon), "base64"));
    }
    if (/^[0-9A-Fa-f]+$/.test(s) && s.length % 32 === 0) {
      try { return aes128Decrypt(key, staticIv(authIv), Buffer.from(s, "hex")); } catch { /* try base64 */ }
    }
    return aes128Decrypt(key, staticIv(authIv), Buffer.from(s, "base64"));
  }

  const aesKey = Buffer.from(authKey.trim(), "base64");
  const hmacKey = Buffer.from(authIv.trim(), "base64");
  if (!/^[0-9A-Fa-f]+$/.test(raw) || raw.length % 2 !== 0) throw new Error("SabPaisa payload is not hex");
  const full = Buffer.from(raw, "hex");
  if (full.length < 48 + 12 + 16) throw new Error("SabPaisa payload too short");
  const message = full.subarray(48);
  const expected = createHmac("sha384", hmacKey).update(message).digest();
  if (!timingSafeEqual(full.subarray(0, 48), expected)) {
    throw new Error("SabPaisa HMAC check failed — payload tampered or wrong keys");
  }
  const d = createDecipheriv("aes-256-gcm", aesKey, message.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(message.subarray(message.length - 16));
  return Buffer.concat([d.update(message.subarray(12, message.length - 16)), d.final()]).toString("utf8");
}

function staticIv(authIv: string): Buffer {
  const iv = Buffer.from((authIv ?? "").trim(), "utf8");
  if (iv.length !== 16) throw new Error("SABPAISA_AUTH_IV must be 16 characters for the AES-128 keys");
  return iv;
}

function aes128Decrypt(key: Buffer, iv: Buffer, ct: Buffer): string {
  const d = createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
