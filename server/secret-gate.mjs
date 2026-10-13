// The secret gate. The vault rule says raw passwords, tokens, API keys and
// private keys are never stored - but until this gate the rule lived only in
// tool descriptions, so it held exactly as well as the model reading them.
// Every write path now runs its text through here first, before anything is
// sent to the metadata model, the embedder or the database.
//
// High precision over high recall: each pattern is the shape of a real
// credential, not a word that merely sounds like one. A false refusal blocks a
// legitimate memory with no way around it, so the assignment pattern skips
// placeholders, environment-variable names and SECRET_REF pointers. The audit
// script's softer checks (memory-quality.mjs) still flag the grey cases.
//
// There is deliberately no override. Storing a raw secret is never right in
// this memory: the value belongs in the secret store and the memory holds a
// SECRET_REF pointer to it.

const PATTERNS = [
  ["private-key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["api-key", /\bsk-(?:ant-|or-v1-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["brave-api-key", /\bBSA[A-Za-z0-9_-]{20,}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["url-credentials", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{6,})@/i],
];

// password: hunter2-ish assignments. The key has to be a credential word and
// the value has to look like a value, not like a name for one.
const ASSIGNMENT = /\b(?:password|passwd|pwd|lösenord|passphrase|secret|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)\b["']?\s*[:=]\s*["'`]?([^\s"'`,;]{8,})/giu;

function looksLikeValue(value) {
  if (/^[$<{%[(]/.test(value)) return false; // ${VAR}, <token>, {{ secret }}, %VAR%
  if (/^[A-Z][A-Z0-9_]+$/.test(value)) return false; // OPENROUTER_API_KEY
  if (/SECRET_REF|REDACTED|example|placeholder|changeme|your[-_]/i.test(value)) return false;
  if (/^(.)\1+$/.test(value) || /^[x*•.]+$/i.test(value)) return false; // xxxxxxxx, ********
  if (/^(?:true|false|null|none|required|optional)$/i.test(value)) return false;
  if (/^[\w.-]+\.(?:md|json|env|ya?ml|txt|key|pem|ps1|sh)$/i.test(value)) return false; // a file name
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}

function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, out);
  return out;
}

// The kind of credential found anywhere in the given values (strings, arrays
// or metadata objects), or null. Only the kind is ever reported: the matched
// text must not reach a log, an error message or a usage row.
export function findSecret(...values) {
  for (const text of strings(values)) {
    for (const [kind, pattern] of PATTERNS) if (pattern.test(text)) return kind;
    for (const match of text.matchAll(ASSIGNMENT)) if (looksLikeValue(match[1])) return "password-assignment";
  }
  return null;
}

export class SecretRefused extends Error {
  constructor(kind) {
    super(
      `Refused: the text appears to contain a credential (${kind}). Nothing was saved or sent on. ` +
      "Keep the value in the secret store and save only a SECRET_REF pointer to where it lives.",
    );
    this.name = "SecretRefused";
    this.status = 422;
    this.kind = kind;
  }
}

export function refuseSecrets(...values) {
  const kind = findSecret(...values);
  if (kind) throw new SecretRefused(kind);
}
