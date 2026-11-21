/**
 * Copies arbitrary plain text (Markdown, CSV, JSON, identifiers) to the system clipboard,
 * with a hidden readonly textarea fallback for sandboxed iframes where navigator.clipboard is restricted.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.className = 'sr-only';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Copies a normalized hex color string (e.g. "#1E3A5F") to the system clipboard,
 * with a DOM fallback for embedded iframes or browsers where navigator.clipboard is restricted.
 */
export async function copyHexToClipboard(hex: string): Promise<string | null> {
  const cleaned = hex.trim().toUpperCase();
  if (!cleaned) return null;
  const normalized = cleaned.startsWith('#') ? cleaned : `#${cleaned}`;
  const ok = await copyTextToClipboard(normalized);
  return ok ? normalized : null;
}
