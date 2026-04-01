/**
 * @typedef {{ linked: boolean, seerrUserId?: number, seerrUsername?: string, isAdmin: boolean, telegramUserId: number }} UserState
 * @typedef {{ has4kMovie: boolean, has4kTv: boolean }} Capabilities
 * @typedef {{ type: string, id: number, data: any }} DetailState
 * @typedef {{ id: number, name: string }} Genre
 * @typedef {{ yearFrom?: string, yearTo?: string, ratingFrom?: string, ratingTo?: string, sortBy?: string }} FilterSet
 * @typedef {{ status?: number }} MediaInfo
 */

// ── Telegram Web App ─────────────────────────

/** @type {TelegramWebApp | undefined} */
export const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

/** @type {string} */
export const initData = tg?.initData ?? "";

/** @type {boolean} */
export const isTelegramWebApp = !!initData;

/** @type {string} */
export const TMDB_IMG = "https://image.tmdb.org/t/p";

// ── State (getter/setter to avoid ES module live-binding issues) ──

/** @type {string} */
let _currentTab = "trending";
/** @returns {string} */
export function getCurrentTab() { return _currentTab; }
/** @param {string} tab */
export function setCurrentTab(tab) { _currentTab = tab; }

/** @type {DetailState | null} */
let _currentDetail = null;
/** @returns {DetailState | null} */
export function getCurrentDetail() { return _currentDetail; }
/** @param {DetailState | null} detail */
export function setCurrentDetail(detail) { _currentDetail = detail; }

/** @type {Set<number>} */
let _selectedSeasons = new Set();
/** @returns {Set<number>} */
export function getSelectedSeasons() { return _selectedSeasons; }
/** @param {Set<number>} s */
export function setSelectedSeasons(s) { _selectedSeasons = s; }

/** @type {{ movie: Genre[] | null, tv: Genre[] | null, anime: Genre[] | null }} */
let _genresCache = { movie: null, tv: null, anime: null };
/** @returns {{ movie: Genre[] | null, tv: Genre[] | null, anime: Genre[] | null }} */
export function getGenresCache() { return _genresCache; }

/** @type {{ movie: number | null, tv: number | null, anime: number | null }} */
let _activeGenre = { movie: null, tv: null, anime: null };
/** @returns {{ movie: number | null, tv: number | null, anime: number | null }} */
export function getActiveGenre() { return _activeGenre; }

/** @type {number} */
let _trendingPage = 1;
/** @returns {number} */
export function getTrendingPage() { return _trendingPage; }
/** @param {number} p */
export function setTrendingPage(p) { _trendingPage = p; }

/** @type {ReturnType<typeof setTimeout> | null} */
let _searchTimeout = null;
/** @returns {ReturnType<typeof setTimeout> | null} */
export function getSearchTimeout() { return _searchTimeout; }
/** @param {ReturnType<typeof setTimeout> | null} t */
export function setSearchTimeout(t) { _searchTimeout = t; }

/** @type {string} */
let _previousView = "trending";
/** @returns {string} */
export function getPreviousView() { return _previousView; }
/** @param {string} v */
export function setPreviousView(v) { _previousView = v; }

/** @type {UserState | null} */
let _userState = null;
/** @returns {UserState | null} */
export function getUserState() { return _userState; }
/** @param {UserState | null} state */
export function setUserState(state) { _userState = state; }

/** @type {{ movie: FilterSet, tv: FilterSet, anime: FilterSet }} */
let _activeFilters = { movie: {}, tv: {}, anime: {} };
/** @returns {{ movie: FilterSet, tv: FilterSet, anime: FilterSet }} */
export function getActiveFilters() { return _activeFilters; }

/** @type {Array<{ type: string, id: number }>} */
let _navigationStack = [];
/** @returns {Array<{ type: string, id: number }>} */
export function getNavigationStack() { return _navigationStack; }
/** @param {Array<{ type: string, id: number }>} s */
export function setNavigationStack(s) { _navigationStack = s; }

/** @type {Capabilities} */
let _caps = { has4kMovie: false, has4kTv: false };
/** @returns {Capabilities} */
export function getCaps() { return _caps; }
/** @param {Capabilities} c */
export function setCaps(c) { _caps = c; }

// ── Auth ─────────────────────────────────────

/** @returns {Record<string, string>} */
export function getAuthHeaders() {
  if (isTelegramWebApp) {
    return { "X-Telegram-Init-Data": initData };
  }
  const loginData = localStorage.getItem("tg_login");
  if (loginData) {
    return { "X-Telegram-Login-Data": loginData };
  }
  return {};
}

// ── API ──────────────────────────────────────

/**
 * @param {string} path
 * @returns {Promise<any>}
 */
export async function api(path) {
  const res = await fetch(path, {
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

/**
 * @param {string} path
 * @param {any} body
 * @returns {Promise<any>}
 */
export async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...getAuthHeaders(),
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Helpers ──────────────────────────────────

/**
 * @param {string | null} path
 * @param {string} [size="w342"]
 * @returns {string}
 */
export function posterUrl(path, size = "w342") {
  if (!path) return "";
  return `${TMDB_IMG}/${size}${path}`;
}

/**
 * @param {string | undefined} date
 * @returns {string}
 */
export function year(date) {
  return date ? date.slice(0, 4) : "????";
}

/**
 * @param {MediaInfo | null | undefined} mediaInfo
 * @returns {string}
 */
export function statusBadge(mediaInfo) {
  if (!mediaInfo) return "";
  switch (mediaInfo.status) {
    case 5: return '<span class="badge badge-available">Available</span>';
    case 2: return '<span class="badge badge-requested">Requested</span>';
    case 3: return '<span class="badge badge-downloading">Downloading</span>';
    case 4: return '<span class="badge badge-requested">Partial</span>';
    default: return "";
  }
}

/**
 * @param {number} status
 * @returns {string}
 */
export function statusText(status) {
  switch (status) {
    case 5: return "Available";
    case 4: return "Partially available";
    case 3: return "Downloading";
    case 2: return "Requested";
    default: return "Not in library";
  }
}

/**
 * @param {number} status
 * @returns {string}
 */
export function statusIcon(status) {
  switch (status) {
    case 5: return "&#9989;";
    case 4: return "&#128993;";
    case 3: return "&#9881;&#65039;";
    case 2: return "&#9203;";
    default: return "&#128308;";
  }
}

/**
 * @param {number} status
 * @returns {string}
 */
export function requestStatusText(status) {
  switch (status) {
    case 1: return "Pending";
    case 2: return "Approved";
    case 3: return "Declined";
    case 4: return "Failed";
    case 5: return "Available";
    default: return "Unknown";
  }
}

/**
 * @param {number} status
 * @returns {string}
 */
export function requestStatusClass(status) {
  switch (status) {
    case 1: return "badge-requested";
    case 2: return "badge-approved";
    case 3: return "badge-declined";
    case 4: return "badge-declined";
    case 5: return "badge-available";
    default: return "";
  }
}

/** @returns {void} */
export function showLoading() { document.getElementById("loading").classList.remove("hidden"); }

/** @returns {void} */
export function hideLoading() { document.getElementById("loading").classList.add("hidden"); }

/**
 * @param {string} msg
 * @returns {void}
 */
export function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/**
 * @param {string} s
 * @returns {string}
 */
export function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/**
 * @param {string | undefined} dateStr
 * @returns {string}
 */
export function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
