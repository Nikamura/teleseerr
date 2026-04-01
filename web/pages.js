import {
  tg, isTelegramWebApp, api,
  posterUrl, escHtml, formatDate,
  requestStatusText, requestStatusClass,
  showLoading, hideLoading, toast,
  getCurrentTab, getUserState,
} from "./state.js";
import { addLoadMore, removeLoadMore } from "./grid.js";
import { openDetail, removeRequestBar } from "./detail.js";

// ── My Requests ─────────────────────────────

/**
 * @param {HTMLElement} view
 * @returns {Promise<void>}
 */
export async function loadRequests(view) {
  view.innerHTML = '<div class="request-list-loading"><div class="spinner" style="width:24px;height:24px;margin:40px auto"></div></div>';

  try {
    const data = await api("/api/requests?page=1");

    if (data.results.length === 0) {
      view.innerHTML = '<div class="empty">No requests yet. Start exploring and plunder some media!</div>';
      return;
    }

    view.innerHTML = "";
    renderRequestList(data.results, view);

    if (data.pageInfo.pages > 1) {
      let page = 1;
      addLoadMore(view, async () => {
        page++;
        const more = await api(`/api/requests?page=${page}`);
        renderRequestList(more.results, view, true);
        if (page >= more.pageInfo.pages) removeLoadMore(view);
      });
    }
  } catch {
    view.innerHTML = '<div class="empty">Failed to load requests</div>';
  }
}

/**
 * @param {any[]} items
 * @param {HTMLElement} container
 * @param {boolean} [append=false]
 * @returns {void}
 */
export function renderRequestList(items, container, append = false) {
  let list = append ? container.querySelector(".request-list") : null;
  if (!list) {
    list = document.createElement("div");
    list.className = "request-list";
    container.appendChild(list);
  }

  for (const item of items) {
    const el = document.createElement("div");
    el.className = "request-item";
    el.onclick = () => openDetail(item.mediaType, item.tmdbId);

    const poster = item.posterPath
      ? `<img class="request-poster" src="${posterUrl(item.posterPath, "w200")}" alt="" loading="lazy">`
      : '<div class="request-poster request-poster-empty"></div>';

    const typeIcon = item.mediaType === "movie" ? "&#127916;" : "&#128250;";
    const statusCls = requestStatusClass(item.status);

    el.innerHTML = `
      ${poster}
      <div class="request-info">
        <div class="request-title">${typeIcon} ${escHtml(item.title)}${item.is4k ? ' <span class="request-4k">4K</span>' : ""}</div>
        <div class="request-meta">
          <span class="badge ${statusCls}">${requestStatusText(item.status)}</span>
          ${item.mediaStatus === 5 && item.status !== 5 ? '<span class="badge badge-available">Available</span>' : ""}
          <span class="request-date">${formatDate(item.createdAt)}</span>
        </div>
      </div>`;

    list.appendChild(el);
  }
}

// ── Profile View ─────────────────────────────

/** @returns {void} */
export function initProfileBtn() {
  document.getElementById("profile-btn").onclick = () => showProfile();
}

/** @returns {Promise<void>} */
export async function showProfile() {
  const userState = getUserState();
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  const view = document.getElementById("profile-view");
  view.classList.add("active");
  removeRequestBar();

  view.innerHTML = `
    <div class="back-row">
      <button class="back-btn" id="profile-back-btn">&#8592; Back</button>
    </div>
    <div class="profile-card">
      <div class="profile-header">
        <div class="profile-avatar">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
        </div>
        <div>
          <div class="profile-name">${escHtml(userState.seerrUsername || "Not linked")}</div>
          <div class="profile-id">Telegram ID: ${userState.telegramUserId}</div>
        </div>
      </div>
      <div id="quota-section" class="profile-quota">
        <div class="spinner" style="width:20px;height:20px;margin:16px auto"></div>
      </div>
      ${!isTelegramWebApp ? '<button class="logout-btn" id="logout-btn">Log out</button>' : ""}
    </div>`;

  if (!isTelegramWebApp) {
    document.getElementById("logout-btn").onclick = () => {
      localStorage.removeItem("tg_login");
      location.reload();
    };
  }

  document.getElementById("profile-back-btn").onclick = () => {
    view.classList.remove("active");
    document.getElementById(`${getCurrentTab()}-view`).classList.add("active");
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", /** @type {HTMLElement} */ (t).dataset.tab === getCurrentTab()));
  };

  if (tg) {
    tg.BackButton.show();
    tg.BackButton.onClick(() => {
      view.classList.remove("active");
      document.getElementById(`${getCurrentTab()}-view`).classList.add("active");
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", /** @type {HTMLElement} */ (t).dataset.tab === getCurrentTab()));
      tg.BackButton.hide();
    });
  }

  // Load quota
  if (userState.linked) {
    try {
      const quota = await api("/api/quota");
      const section = document.getElementById("quota-section");
      section.innerHTML = `
        <div class="quota-title">Request Quota</div>
        ${renderQuotaBar("Movies", quota.movie)}
        ${renderQuotaBar("TV Shows", quota.tv)}`;
    } catch {
      document.getElementById("quota-section").innerHTML = '<div class="empty" style="padding:12px">Could not load quota</div>';
    }
  } else {
    document.getElementById("quota-section").innerHTML = "";
  }
}

/**
 * @param {string} label
 * @param {{ restricted: boolean, limit?: number, remaining?: number, days?: number }} q
 * @returns {string}
 */
export function renderQuotaBar(label, q) {
  if (!q.restricted) {
    return `
      <div class="quota-row">
        <span class="quota-label">${label}</span>
        <span class="quota-value">Unlimited</span>
      </div>`;
  }
  const pct = q.limit > 0 ? Math.round(((q.limit - q.remaining) / q.limit) * 100) : 0;
  return `
    <div class="quota-row">
      <span class="quota-label">${label}</span>
      <span class="quota-value">${q.remaining}/${q.limit} remaining (resets in ${q.days}d)</span>
    </div>
    <div class="quota-bar-bg">
      <div class="quota-bar-fill" style="width:${pct}%"></div>
    </div>`;
}

// ── Unlinked View ────────────────────────────

/** @returns {void} */
export function showUnlinked() {
  const userState = getUserState();
  // Hide everything except unlinked view
  /** @type {HTMLElement} */ (document.querySelector(".top-bar")).style.display = "none";
  document.getElementById("tabs-nav").style.display = "none";
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));

  const view = document.getElementById("unlinked-view");
  view.classList.add("active");
  view.innerHTML = `
    <div class="unlinked-screen">
      <div class="unlinked-icon">&#9203;</div>
      <h2 class="unlinked-title">Waiting for access</h2>
      <p class="unlinked-text">The admin has been notified. You'll get a message once your account is linked.</p>
      <div class="unlinked-id-box">
        <div class="unlinked-id-label">Your Telegram ID</div>
        <div class="unlinked-id-value">${userState.telegramUserId}</div>
      </div>
    </div>`;
}

// ── Telegram Login (browser) ─────────────────

/** @returns {void} */
export function showLoginScreen() {
  /** @type {HTMLElement} */ (document.querySelector(".top-bar")).style.display = "none";
  document.getElementById("tabs-nav").style.display = "none";
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));

  const view = document.getElementById("unlinked-view");
  view.classList.add("active");
  view.innerHTML = `
    <div class="unlinked-screen">
      <div class="unlinked-icon">&#9875;</div>
      <h2 class="unlinked-title">Ahoy, sailor!</h2>
      <p class="unlinked-text">Log in with your Telegram account to start plundering media.</p>
      <div id="telegram-login-wrap"></div>
    </div>`;

  loadTelegramLoginWidget();
}

/** @returns {Promise<void>} */
export async function loadTelegramLoginWidget() {
  const wrap = document.getElementById("telegram-login-wrap");
  try {
    const res = await fetch("/api/bot-info");
    if (!res.ok) throw new Error("Failed to fetch bot info");
    const { username } = await res.json();

    // Expose global callback for the widget
    window.onTelegramAuth = function (user) {
      localStorage.setItem("tg_login", JSON.stringify(user));
      location.reload();
    };

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", username);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-radius", "8");
    script.setAttribute("data-lang", "en");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    script.setAttribute("data-request-access", "write");
    script.async = true;
    wrap.appendChild(script);
  } catch {
    wrap.innerHTML = '<p class="unlinked-hint">Could not load login. Try opening from Telegram instead.</p>';
  }
}
