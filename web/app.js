import { tg, isTelegramWebApp, api, setCurrentTab, setPreviousView, setUserState, getUserState, setCaps } from "./state.js";
import { setCardClickHandler } from "./grid.js";
import { loadDiscoverPage, loadGenreView, initSearch } from "./discover.js";
import { openDetail, removeRequestBar } from "./detail.js";
import { loadRequests, initProfileBtn, showUnlinked, showLoginScreen } from "./pages.js";
import { showAdmin } from "./admin.js";

// ── Wire up grid card clicks to detail view ──

setCardClickHandler((type, id) => openDetail(type, id));

// ── Tab Navigation ───────────────────────────

/** @returns {void} */
function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    /** @type {HTMLElement} */ (tab).onclick = () => switchTab(/** @type {HTMLElement} */ (tab).dataset.tab);
  });
}

/**
 * @param {string} tab
 * @returns {void}
 */
function switchTab(tab) {
  setCurrentTab(tab);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", /** @type {HTMLElement} */ (t).dataset.tab === tab));
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));

  const viewId = `${tab}-view`;
  document.getElementById(viewId).classList.add("active");
  setPreviousView(tab);

  removeRequestBar();

  // Clear search when switching tabs
  const searchInput = /** @type {HTMLInputElement} */ (document.getElementById("search-input"));
  if (searchInput.value.trim().length > 0) {
    searchInput.value = "";
  }

  const view = document.getElementById(viewId);
  if (!view.children.length || (view.children.length === 1 && view.querySelector(".skeleton"))) {
    loadTabContent(tab);
  }

  if (tg) tg.BackButton.hide();
}

/**
 * @param {string} tab
 * @returns {Promise<void>}
 */
async function loadTabContent(tab) {
  if (tab === "admin") {
    await showAdmin();
    return;
  }

  const view = document.getElementById(`${tab}-view`);

  if (tab === "trending") {
    await loadDiscoverPage(view);
  } else if (tab === "movies" || tab === "tv" || tab === "anime") {
    const type = tab === "movies" ? "movie" : tab === "anime" ? "anime" : "tv";
    await loadGenreView(type, view);
  } else if (tab === "requests") {
    await loadRequests(view);
  }
}

// ── Init ─────────────────────────────────────

/** @returns {Promise<void>} */
async function init() {
  // If not in Telegram and no saved login, show login screen
  if (!isTelegramWebApp && !localStorage.getItem("tg_login")) {
    setUserState({ linked: false, isAdmin: false, telegramUserId: 0 });
    showLoginScreen();
    return;
  }

  try {
    setUserState(await api("/api/me"));
  } catch {
    // Auth failed — if browser login is stale, clear it and show login
    if (!isTelegramWebApp) {
      localStorage.removeItem("tg_login");
      setUserState({ linked: false, isAdmin: false, telegramUserId: 0 });
      showLoginScreen();
      return;
    }
    setUserState({ linked: false, isAdmin: false, telegramUserId: 0 });
  }

  const userState = getUserState();

  if (!userState.linked && !userState.isAdmin) {
    showUnlinked();
    return;
  }

  // Add admin tab if needed
  if (userState.isAdmin) {
    const nav = document.getElementById("tabs-nav");
    const adminTab = document.createElement("button");
    adminTab.className = "tab";
    adminTab.dataset.tab = "admin";
    adminTab.textContent = "Admin";
    nav.appendChild(adminTab);
  }

  initTabs();
  initSearch();
  initProfileBtn();

  // Fetch capabilities for 4K support
  api("/api/capabilities").then((c) => { setCaps(c); }).catch(() => {});

  // Load initial content
  loadTabContent("trending");
}

init();
