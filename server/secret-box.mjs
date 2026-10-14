// Provider keys typed into the web UI, sealed before they reach the database.
//
// Everything in app_settings lands in every nightly pg_dump. A key stored there
// in the clear would sit in ten days of backups and in any copy made of them,
// so it is encrypted with AES-256-GCM under SETTINGS_KEY, which lives only in
// .env. The dump then holds ciphertext that is useless without the .env, and the
// .env is kept where secrets are kept.
//
// Without SETTINGS_KEY nothing can be sealed, and the Models card says so
// instead of offering a key field. Change SETTINGS_KEY and every stored key
// stops opening; open() then answers null and the card asks for the keys again
// - a lost key is re-typed, never guessed at.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";

function masterKey() {
  const raw = String(process.env.SETTINGS_KEY || "").trim();
  // Hashed, so any long random string works, hex or not.
  return raw ? createHash("sha256").update(raw, "utf8").digest() : null;
}

export const canSeal = () => Boolean(masterKey());

export function seal(plain) {
  const key = masterKey();
  if (!key) throw Object.assign(new Error("Set SETTINGS_KEY in .env to store keys from the web UI"), { status: 400 });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), body].map((part) =>
    (typeof part === "string" ? part : part.toString("base64"))).join(":");
}

export function open(sealed) {
  const key = masterKey();
  const [version, iv, tag, body] = String(sealed || "").split(":");
  if (!key || version !== VERSION || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
