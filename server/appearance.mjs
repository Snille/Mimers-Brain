// The web interface's theme and accent colour, from Settings -> Appearance.
//
// One setting for the whole brain, not per browser: it is stored in the
// database and handed to every page in /api/config, which the page reads
// before anyone signs in - so the sign-in dialog is in the right colours too.
// It is no secret. Only the full listener may change it, like the rest of
// Settings.
//
// The accent was a hard-coded blue from before Erik's preferences were in the
// brain: dark by default, and his favourite green.

import { getSetting, setSetting } from "./lib.mjs";

const KEY = "ui_appearance";
export const THEMES = Object.freeze(["dark", "light", "system"]);
export const DEFAULT_APPEARANCE = Object.freeze({ theme: "dark", accent: "#95c200" });
const HEX = /^#[0-9a-f]{6}$/i;

const fail = (status, message) => Object.assign(new Error(message), { status });

export function normalise(value = {}) {
  const theme = THEMES.includes(value.theme) ? value.theme : DEFAULT_APPEARANCE.theme;
  const accent = HEX.test(String(value.accent || "")) ? String(value.accent).toLowerCase() : DEFAULT_APPEARANCE.accent;
  return { theme, accent };
}

export async function appearance() {
  try { return normalise(JSON.parse(await getSetting(KEY)) || {}); } catch { return { ...DEFAULT_APPEARANCE }; }
}

// A field left out keeps its value; an empty one brings back the default.
export async function saveAppearance({ theme, accent } = {}) {
  if (theme !== undefined && theme !== "" && !THEMES.includes(theme))
    throw fail(400, `theme must be one of ${THEMES.join(", ")}`);
  if (accent !== undefined && accent !== "" && !HEX.test(String(accent)))
    throw fail(400, "accent must be a colour such as #95c200");
  const current = await appearance();
  const next = normalise({
    theme: theme === undefined ? current.theme : theme || DEFAULT_APPEARANCE.theme,
    accent: accent === undefined ? current.accent : accent || DEFAULT_APPEARANCE.accent,
  });
  await setSetting(KEY, JSON.stringify(next));
  return next;
}
