const STORAGE_KEY = "mimers-brain-language";

let manifest = { default: "en", languages: [{ code: "en", name: "English" }] };
let language = "en";
let messages = {};
let fallback = {};

const get = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);

function interpolate(value, variables) {
  return String(value).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) =>
    Object.hasOwn(variables, key) ? String(variables[key]) : match);
}

async function load(code) {
  const response = await fetch(`./lang/${encodeURIComponent(code)}.json`);
  if (!response.ok) throw new Error(`Could not load language '${code}'`);
  return response.json();
}

function preferredLanguage() {
  let saved = "";
  try { saved = localStorage.getItem(STORAGE_KEY) || ""; } catch { /* unavailable */ }
  const available = new Set(manifest.languages.map((item) => item.code));
  if (available.has(saved)) return saved;

  for (const candidate of navigator.languages || [navigator.language]) {
    if (available.has(candidate)) return candidate;
    const base = String(candidate).split("-")[0];
    if (available.has(base)) return base;
  }
  return available.has(manifest.default) ? manifest.default : manifest.languages[0]?.code || "en";
}

export async function initI18n() {
  const response = await fetch("./lang/languages.json");
  if (response.ok) manifest = await response.json();
  language = preferredLanguage();
  const fallbackCode = manifest.default || "en";
  fallback = await load(fallbackCode);
  if (language === fallbackCode) {
    messages = fallback;
  } else {
    try {
      messages = await load(language);
    } catch {
      language = fallbackCode;
      messages = fallback;
    }
  }
  document.documentElement.lang = language;
  document.title = t("app.title");
  translatePage();
  return language;
}

export function t(key, variables = {}) {
  const value = get(messages, key) ?? get(fallback, key) ?? key;
  return interpolate(value, variables);
}

export function currentLanguage() {
  return language;
}

export function availableLanguages() {
  return manifest.languages;
}

export function chooseLanguage(code) {
  if (!manifest.languages.some((item) => item.code === code)) return;
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* unavailable */ }
  location.reload();
}

export function translatePage(root = document) {
  for (const element of root.querySelectorAll("[data-i18n]"))
    element.textContent = t(element.dataset.i18n);
  for (const element of root.querySelectorAll("[data-i18n-placeholder]"))
    element.placeholder = t(element.dataset.i18nPlaceholder);
  for (const element of root.querySelectorAll("[data-i18n-aria-label]"))
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
}

export function formatDate(value, options = {}) {
  return value ? new Intl.DateTimeFormat(language, options).format(new Date(value)) : "";
}

export function formatDateTime(value) {
  return value
    ? new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(new Date(value))
    : t("common.none");
}
