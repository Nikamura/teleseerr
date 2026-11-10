import { openReports } from "./support.js";
import { icon } from "./icons.js";
import { api, apiPost, escHtml, showLoading, hideLoading, toast, getUserState } from "./state.js";
import { confirmAction, haptic } from "./native.js";

// ── Admin Panel ──────────────────────────────

/** @returns {Promise<void>} */
export async function showAdmin() {
  document.body.dataset.screen = "admin";
  const view = document.getElementById("admin-view");
  view.innerHTML = `
    <div class="page-heading"><p class="section-kicker">Your shared library</p><h1>People</h1><p>Good movie nights start with good company.</p></div>
    <div class="help-entry"><button class="quick-btn secondary" id="admin-problems">Reported problems</button></div><div class="people-tools"><label class="people-search">${icon("search",18)}<input type="search" id="admin-user-filter" placeholder="Find a person" aria-label="Find a linked person"></label><a href="#admin-add-person" class="text-link">Link someone ${icon("arrow",16)}</a></div>
    <div class="admin-section" id="admin-pending-section" style="display:none">
      <div class="admin-section-title">Pending Requests</div>
      <div id="admin-pending-list"></div>
    </div>
    <div class="admin-section">
      <div class="admin-section-title">Library access <span id="admin-user-count"></span></div><p class="section-description">Choose who can recover downloads and replace episodes.</p>
      <div id="admin-users-list"><div class="spinner" style="width:20px;height:20px;margin:16px auto"></div></div><p id="people-no-results" class="empty" hidden>No matching people. Try a different name or email.</p>
    </div>
    <details class="admin-section admin-add-person" id="admin-add-person"><summary>Link someone new</summary>
      <div class="admin-link-form">
        <label class="admin-field">Telegram user ID<input type="number" id="admin-tg-id" placeholder="e.g. 123456789" class="admin-input" inputmode="numeric"></label>
        <button class="admin-btn" id="admin-show-seerr">Find Seerr Users</button>
      </div>
      <div id="seerr-users-list"></div>
    </details>
    <div class="admin-section" id="admin-ignored-section" style="display:none">
      <div class="admin-section-title admin-ignored-toggle" id="admin-ignored-toggle">Ignored Users <span class="admin-toggle-arrow">&#9654;</span></div>
      <div id="admin-ignored-list" style="display:none"></div>
    </div>`;
  document.getElementById("admin-problems").onclick = openReports;

  document.getElementById("admin-user-filter").oninput = (event) => {
    const term = /** @type {HTMLInputElement} */ (event.target).value.trim().toLowerCase();
    const rows = [...document.querySelectorAll(".admin-user-row")];
    rows.forEach(row => { /** @type {HTMLElement} */ (row).hidden = !row.textContent.toLowerCase().includes(term); });
    document.getElementById("people-no-results").hidden = rows.some(row => !/** @type {HTMLElement} */ (row).hidden);
  };
  document.querySelector('a[href="#admin-add-person"]').addEventListener("click", () => { /** @type {HTMLDetailsElement} */ (document.getElementById("admin-add-person")).open = true; });
  document.getElementById("admin-show-seerr").onclick = () => loadSeerrUsers(1);
  document.getElementById("admin-ignored-toggle").onclick = () => {
    const list = document.getElementById("admin-ignored-list");
    const arrow = /** @type {HTMLElement} */ (document.querySelector(".admin-toggle-arrow"));
    const open = list.style.display !== "none";
    list.style.display = open ? "none" : "";
    arrow.textContent = open ? "\u25B6" : "\u25BC";
  };

  await Promise.all([loadAdminUsers(), loadPendingUsers(), loadIgnoredUsers()]);
}

/** @returns {Promise<void>} */
export async function loadAdminUsers() {
  const list = document.getElementById("admin-users-list");
  try {
    const users = await api("/api/admin/users");
    if (users.length === 0) {
      list.innerHTML = '<div class="empty" style="padding:12px">No linked users</div>';
      return;
    }
    document.getElementById("admin-user-count").textContent = String(users.length);
    list.innerHTML = users.map((u) => {
      const owner = u.telegramUserId === getUserState()?.telegramUserId;
      const name = (u.seerrUsername || "Library member").split("@")[0].replace(/[._-]+/g, " ");
      return `<article class="admin-user-row">
        <div class="person-identity"><div class="person-avatar" aria-hidden="true">${escHtml(name.slice(0,1).toUpperCase())}</div><div class="admin-user-info"><span class="person-name">${escHtml(name)}${owner ? '<span class="owner-label">You · Admin</span>' : ""}</span><span class="admin-user-seerr">${escHtml(u.seerrUsername)}</span></div></div>
        <div class="person-permissions"><div><span class="permission-title">Manage downloads</span><span class="permission-description">Recover stuck downloads and replace files</span></div><label class="permission-switch"><input type="checkbox" role="switch" aria-label="Manage downloads for ${escHtml(name)}" class="admin-download-permission" data-tg-id="${u.telegramUserId}" ${u.manageDownloads || owner ? "checked" : ""} ${owner ? "disabled" : ""}><span aria-hidden="true"></span></label></div>
        <details class="person-details"><summary>Account details</summary><div class="person-account"><span>Telegram ID <code>${u.telegramUserId}</code></span>${!owner ? `<button class="admin-unlink-btn" data-tg-id="${u.telegramUserId}">${icon("unlink",14)} Unlink account</button>` : '<span class="permission-description">Admin access is always enabled.</span>'}</div></details>
      </article>`;
    }).join("");

    list.querySelectorAll(".admin-download-permission").forEach((element) => {
      const input = /** @type {HTMLInputElement} */ (element);
      input.onchange = async () => {
        input.disabled = true;
        try {
          const result = await apiPost("/api/admin/download-permission", { telegramUserId: Number(input.dataset.tgId), enabled: input.checked });
          if (result.error) throw new Error(result.error);
          haptic("selection"); toast("Download permission updated");
        } catch { input.checked = !input.checked; haptic("error"); toast("Could not update permission"); }
        finally { input.disabled = false; }
      };
    });

    list.querySelectorAll(".admin-unlink-btn").forEach((btn) => {
      /** @type {HTMLElement} */ (btn).onclick = async () => {
        if (!(await confirmAction(`Unlink Telegram user ${/** @type {HTMLElement} */ (btn).dataset.tgId}?`, { ok: "Unlink", destructive: true }))) return;
        showLoading();
        try {
          const response = await apiPost("/api/admin/unlink", { telegramUserId: Number(/** @type {HTMLElement} */ (btn).dataset.tgId) });
          if (response.error) throw new Error(response.error);
          haptic("success"); toast("Account unlinked");
          await loadAdminUsers();
        } catch { haptic("error"); toast("Could not unlink account. Please try again."); }
        finally { hideLoading(); }
      };
    });
  } catch {
    list.innerHTML = '<div class="empty" style="padding:12px">Failed to load users</div>';
  }
}

/** @returns {Promise<void>} */
export async function loadPendingUsers() {
  const section = document.getElementById("admin-pending-section");
  const list = document.getElementById("admin-pending-list");
  try {
    const users = await api("/api/admin/pending");
    if (users.length === 0) {
      section.style.display = "none";
      return;
    }
    section.style.display = "";
    list.innerHTML = users.map((u) => {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "Unknown";
      const tag = u.username ? ` @${u.username}` : "";
      const ago = timeAgo(u.requestedAt);
      return `
      <div class="admin-pending-row">
        <div class="admin-user-info">
          <span class="admin-user-tg">${escHtml(name)}${escHtml(tag)}</span>
          <span class="admin-user-seerr">ID: ${u.telegramUserId} · ${ago}</span>
        </div>
        <div class="admin-pending-actions">
          <button class="admin-ignore-btn" data-tg-id="${u.telegramUserId}">Ignore</button>
          <button class="admin-link-pending-btn" data-tg-id="${u.telegramUserId}">Link</button>
        </div>
      </div>`;
    }).join("");

    list.querySelectorAll(".admin-link-pending-btn").forEach((btn) => {
      /** @type {HTMLElement} */ (btn).onclick = () => {
        /** @type {HTMLInputElement} */ (document.getElementById("admin-tg-id")).value = /** @type {HTMLElement} */ (btn).dataset.tgId;
        /** @type {HTMLDetailsElement} */ (document.getElementById("admin-add-person")).open = true;
        loadSeerrUsers(1);
        document.getElementById("seerr-users-list").scrollIntoView({ behavior: "smooth", block: "start" });
      };
    });

    list.querySelectorAll(".admin-ignore-btn").forEach((btn) => {
      /** @type {HTMLElement} */ (btn).onclick = async () => {
        showLoading();
        await apiPost("/api/admin/ignore", { telegramUserId: Number(/** @type {HTMLElement} */ (btn).dataset.tgId) });
        hideLoading();
        toast("User ignored");
        loadPendingUsers();
        loadIgnoredUsers();
      };
    });
  } catch {
    section.style.display = "none";
  }
}

/**
 * @param {number} ts
 * @returns {string}
 */
export function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** @returns {Promise<void>} */
export async function loadIgnoredUsers() {
  const section = document.getElementById("admin-ignored-section");
  const list = document.getElementById("admin-ignored-list");
  try {
    const users = await api("/api/admin/ignored?details=1");
    if (users.length === 0) {
      section.style.display = "none";
      return;
    }
    section.style.display = "";
    list.innerHTML = users.map((user) => `
      <div class="admin-user-row">
        <div class="admin-user-info">
          <span class="admin-user-tg">${escHtml([user.firstName, user.lastName].filter(Boolean).join(" ") || "Unknown")}${user.username ? ` ${escHtml("@" + user.username)}` : ""}</span>
          <span class="admin-user-seerr">ID: ${user.telegramUserId}</span>
        </div>
        <button class="admin-unignore-btn" data-tg-id="${user.telegramUserId}">Restore</button>
      </div>`).join("");

    list.querySelectorAll(".admin-unignore-btn").forEach((btn) => {
      /** @type {HTMLElement} */ (btn).onclick = async () => {
        showLoading();
        await apiPost("/api/admin/unignore", { telegramUserId: Number(/** @type {HTMLElement} */ (btn).dataset.tgId) });
        hideLoading();
        toast("User restored — they can request access again");
        loadIgnoredUsers();
      };
    });
  } catch {
    section.style.display = "none";
  }
}

/**
 * @param {number} page
 * @returns {Promise<void>}
 */
export async function loadSeerrUsers(page) {
  const list = document.getElementById("seerr-users-list");
  const tgId = /** @type {HTMLInputElement} */ (document.getElementById("admin-tg-id")).value.trim();

  list.innerHTML = '<div class="spinner" style="width:20px;height:20px;margin:16px auto"></div>';

  try {
    const data = await api(`/api/admin/seerr-users?page=${page}`);
    let html = data.results.map((u) => `
      <div class="seerr-user-row" data-seerr-id="${u.id}">
        <div class="seerr-user-info">
          <span class="seerr-user-name">${escHtml(u.username || u.email)}</span>
          <span class="seerr-user-requests">${u.requestCount} requests</span>
        </div>
        <button class="admin-link-btn" data-seerr-id="${u.id}">Link</button>
      </div>`).join("");

    if (data.pageInfo.pages > 1) {
      html += '<div class="admin-pagination">';
      if (page > 1) html += `<button class="admin-page-btn" data-page="${page - 1}">Prev</button>`;
      html += `<span class="admin-page-info">${page}/${data.pageInfo.pages}</span>`;
      if (page < data.pageInfo.pages) html += `<button class="admin-page-btn" data-page="${page + 1}">Next</button>`;
      html += "</div>";
    }

    list.innerHTML = html;

    list.querySelectorAll(".admin-link-btn").forEach((btn) => {
      /** @type {HTMLElement} */ (btn).onclick = async () => {
        if (!tgId) { toast("Enter a Telegram User ID first"); return; }
        showLoading();
        try {
          await apiPost("/api/admin/link", {
            telegramUserId: Number(tgId),
            seerrUserId: Number(/** @type {HTMLElement} */ (btn).dataset.seerrId),
          });
          toast("User linked!");
          /** @type {HTMLInputElement} */ (document.getElementById("admin-tg-id")).value = "";
          list.innerHTML = "";
          loadAdminUsers();
          loadPendingUsers();
        } catch {
          toast("Failed to link user");
        }
        hideLoading();
      };
    });

    list.querySelectorAll(".admin-page-btn").forEach((btn) => {
      /** @type {HTMLElement} */ (btn).onclick = () => loadSeerrUsers(Number(/** @type {HTMLElement} */ (btn).dataset.page));
    });
  } catch {
    list.innerHTML = '<div class="empty" style="padding:12px">Failed to load Seerr users</div>';
  }
}
