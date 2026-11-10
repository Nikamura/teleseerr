// Feature-detected wrappers over Telegram Mini App native UI. Every helper degrades to a
// browser equivalent or a no-op, so the browser-login path keeps working unchanged.

/**
 * The SDK script also loads in the browser-login path, where it reports version 6.0 and has
 * no initData. Native calls are only made inside a real Telegram client that is new enough.
 * @param {string} version Minimum Bot API version of the feature.
 * @returns {TelegramWebApp | null}
 */
function client(version) {
  const tg = window.Telegram?.WebApp;
  if (!tg?.initData || typeof tg.isVersionAtLeast !== "function") return null;
  try { return tg.isVersionAtLeast(version) ? tg : null; } catch { return null; }
}

/**
 * Native confirmation popup (Bot API 6.2); falls back to window.confirm in the browser, on old
 * clients, for messages over the 256-character popup limit, and when a popup is already open.
 * @param {string} message
 * @param {{ ok?: string, destructive?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export function confirmAction(message, options = {}) {
  const tg = client("6.2");
  return new Promise((resolve) => {
    if (tg && typeof tg.showPopup === "function" && message.length <= 256) {
      try {
        tg.showPopup({
          message,
          buttons: [
            { id: "ok", type: options.destructive ? "destructive" : "default", text: (options.ok ?? "Confirm").slice(0, 64) },
            { type: "cancel" },
          ],
        }, (id) => resolve(id === "ok"));
        return;
      } catch { /* Invalid parameters or another popup is open: use the browser dialog. */ }
    }
    resolve(window.confirm(message));
  });
}

/**
 * Haptic feedback (Bot API 6.1). "selection" is for selection changes only, not confirmations.
 * @param {"success" | "error" | "warning" | "selection"} kind
 * @returns {void}
 */
export function haptic(kind) {
  const feedback = client("6.1")?.HapticFeedback;
  if (!feedback) return;
  try {
    if (kind === "selection") feedback.selectionChanged();
    else feedback.notificationOccurred(kind);
  } catch { /* Cosmetic only. */ }
}

/**
 * Ask before the Mini App is closed while unsent input exists (Bot API 6.2).
 * @param {boolean} enabled
 * @returns {void}
 */
export function closingConfirmation(enabled) {
  const tg = client("6.2");
  if (!tg) return;
  try {
    if (enabled) tg.enableClosingConfirmation?.();
    else tg.disableClosingConfirmation?.();
  } catch { /* Cosmetic only. */ }
}

let writeAccessAsked = false;

/**
 * Ask once per session for permission to send DMs (Bot API 6.9), for users who opened the Mini
 * App without pressing Start. Skipped when Telegram already reports the permission.
 * @returns {void}
 */
export function ensureWriteAccess() {
  const tg = client("6.9");
  if (!tg || writeAccessAsked || typeof tg.requestWriteAccess !== "function") return;
  if (tg.initDataUnsafe?.user?.allows_write_to_pm) return;
  writeAccessAsked = true;
  try { tg.requestWriteAccess(); } catch { /* The user can still press Start in the bot chat. */ }
}

/**
 * Dismiss the on-screen keyboard: blur works everywhere, hideKeyboard (Bot API 9.1) covers
 * Telegram clients that keep the keyboard open after blur.
 * @param {HTMLElement | null} [input]
 * @returns {void}
 */
export function dismissKeyboard(input) {
  input?.blur();
  const tg = client("9.1");
  try { tg?.hideKeyboard?.(); } catch { /* Blur already happened. */ }
}

/**
 * Whether a home-screen shortcut can be offered (Bot API 8.0). Resolves false in the browser,
 * on unsupported devices and when the shortcut already exists.
 * @returns {Promise<boolean>}
 */
export function canAddToHomeScreen() {
  const tg = client("8.0");
  return new Promise((resolve) => {
    if (!tg || typeof tg.checkHomeScreenStatus !== "function" || typeof tg.addToHomeScreen !== "function") { resolve(false); return; }
    try { tg.checkHomeScreenStatus((status) => resolve(status === "missed" || status === "unknown")); } catch { resolve(false); }
  });
}

/** @returns {void} */
export function addToHomeScreen() {
  try { client("8.0")?.addToHomeScreen?.(); } catch { /* Unsupported device. */ }
}
