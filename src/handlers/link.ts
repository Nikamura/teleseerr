import { config } from "../config.js";
import { log } from "../logger.js";
import { accountStore } from "../stores.js";
import * as seerr from "../seerr/client.js";
import type { AccountLink } from "../types.js";

// ── Auto-link admin on startup ───────────────────

export async function autoLinkAdmin(): Promise<void> {
  if (!config.ADMIN_SEERR_USER_ID) return;
  if (accountStore.get(config.ADMIN_USER_ID)) return;

  const user = await seerr.getUser(config.ADMIN_SEERR_USER_ID);
  if (!user) {
    log.warn({ seerrUserId: config.ADMIN_SEERR_USER_ID }, "Could not fetch admin Seerr user for auto-link");
    return;
  }

  const link: AccountLink = {
    telegramUserId: config.ADMIN_USER_ID,
    seerrUserId: user.id,
    seerrUsername: user.username || user.email,
    linkedAt: Date.now(),
  };
  accountStore.set(link);
  log.info({ seerrUser: link.seerrUsername }, "Auto-linked admin to Seerr account");
}
