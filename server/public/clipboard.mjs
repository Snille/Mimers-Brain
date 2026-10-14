// The LAN listener is plain http, which is not a secure context - so
// navigator.clipboard does not exist there at all, and the LAN listener is where
// the web UI is used at home. The deprecated execCommand path is the one that
// actually runs there.
export async function copy(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
