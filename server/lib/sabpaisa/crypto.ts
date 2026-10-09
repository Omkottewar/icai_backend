// AES-128-CBC + PKCS7 helpers matching SabPaisa's PHP 7+ integration scheme.
//
// SabPaisa's own PHP sample uses `openssl_encrypt($plain, 'AES-128-CBC',
// $key, OPENSSL_RAW_DATA, $iv)` → base64_encode. OpenSSL's default padding
// is PKCS7; Node's `createCipheriv` likewise defaults to PKCS7 when the
// explicit setAutoPadding stays on. The two implementations are byte-for-
// byte compatible as long as:
//   • key + IV are exactly 16 bytes (ASCII, as sent by SabPaisa — not hex)
//   • output ciphertext is base64 (no URL-safe variant)
//   • input plaintext is UTF-8
//
// If SabPaisa ever rotates to AES-256 / CFB / GCM, swap the algorithm name
// here — nowhere else in the codebase hard-codes it.

import { createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-128-cbc";

export function encrypt(plaintext: string, key: string, iv: string): string {
  const cipher = createCipheriv(ALGORITHM, Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return encrypted.toString("base64");
}

export function decrypt(base64Ciphertext: string, key: string, iv: string): string {
  const decipher = createDecipheriv(ALGORITHM, Buffer.from(key, "utf8"), Buffer.from(iv, "utf8"));
  const decrypted = Buffer.concat([
    decipher.update(base64Ciphertext, "base64"),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
