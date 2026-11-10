import { watchForUpdates } from "./updates.js";
import { navigate, startRouter, tabPath, backRoute } from "./router.js";
import { openServiceStatus } from "./support.js";
import { icon } from "./icons.js";
import { tg, isTelegramWebApp, api, setCurrentTab, getCurrentTab, setPreviousView, setUserState, getUserState, setCaps, clearProgressPolling } from "./state.js";
import { setCardClickHandler } from "./grid.js";
import { loadDiscoverPage, loadGenreView, initSearch, doSearch } from "./discover.js";
import { openDetail, openPerson, removeRequestBar } from "./detail.js";
import { loadRequests, initProfileBtn, showUnlinked, showLoginScreen, showProfile } from "./pages.js";
import { showAdmin } from "./admin.js";
import { haptic } from "./native.js";

watchForUpdates();

// ── Wire up grid card clicks to detail view ──

setCardClickHandler((type, id) => openDetail(type, id));

// ── Tab Navigation ───────────────────────────

/** @returns {void} */
function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    /** @type {HTMLElement} */ (tab).onclick = (event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); if (!tab.classList.contains("active")) haptic("selection"); switchTab(/** @type {HTMLElement} */ (tab).dataset.tab); };
  });
}

/**
 * @param {string} tab
 * @returns {Promise<void>}
 */
async function switchTab(tab, routed = false) {
  if (!routed) { navigate(tabPath(tab)); return; }
  clearProgressPolling();
  setCurrentTab(tab);
  document.body.dataset.screen = tab;
  window.scrollTo(0, 0);
  document.querySelectorAll(".tab").forEach((t) => {
    const target = /** @type {HTMLElement} */ (t).dataset.tab;
    const active = target === tab || (t.closest(".primary-nav") && target === "trending" && ["movies", "tv", "anime"].includes(tab));
    t.classList.toggle("active", !!active);
    t.setAttribute("aria-current", active ? "page" : "false");
  });
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
  if (tab === "profile") { await showProfile(true); return; }
  if (["admin", "requests"].includes(tab) || !view.children.length || (view.children.length === 1 && view.querySelector(".skeleton"))) {
    await loadTabContent(tab);
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
  if (window.Telegram?.WebApp?.colorScheme === "light") document.documentElement.dataset.theme = "light";
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
    const adminTab = document.createElement("a");
    adminTab.href = "/people";
    adminTab.className = "tab";
    adminTab.dataset.tab = "admin";
    adminTab.innerHTML = `${icon("people")}<span>People</span>`;
    nav.insertBefore(adminTab, nav.lastElementChild);
  }

  document.querySelectorAll("[data-icon]").forEach(el => { el.innerHTML = icon(/** @type {HTMLElement} */ (el).dataset.icon, 23); });
  document.querySelector(".brand").addEventListener("click", event => { event.preventDefault(); switchTab("trending"); });
  document.body.dataset.screen = "trending";
  initTabs();
  initSearch();
  initProfileBtn();
  if (tg) tg.BackButton.onClick(() => backRoute(tabPath(getCurrentTab())));

  // Fetch capabilities for 4K support
  api("/api/capabilities").then((c) => { setCaps(c); }).catch(() => {});

  api("/api/support/status").then(status => {
    const unavailable=status.services.filter(s=>!s.available);
    if (!unavailable.length) return;
    const banner=document.createElement("button");banner.className="service-banner";banner.textContent=`${unavailable.map(s=>s.name).join(", ")} unavailable · Check status`;banner.onclick=openServiceStatus;document.querySelector(".top-bar")?.after(banner);
  }).catch(()=>{});

  // One route renderer for click navigation, deep links and browser Back/Forward.
  startRouter(async (route, state) => {
    document.querySelectorAll("dialog[open]").forEach(dialog => /** @type {HTMLDialogElement} */(dialog).close());
    if (route.kind === "tab") {
      if (route.tab === "admin" && !getUserState().isAdmin) { navigate("/discover",{replace:true}); return; }
      await switchTab(route.tab, true);
    } else if (route.kind === "detail") {
      await openDetail(route.type,route.id,true);
    } else if (route.kind === "person") {
      await openPerson(route.id,true);
    } else {
      clearProgressPolling(); removeRequestBar();
      if (tg) tg.BackButton.show();
      document.body.dataset.screen = "search";
      document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
      document.getElementById("search-view").classList.add("active");
      const query = typeof state.query === "string" ? state.query : "";
      /** @type {HTMLInputElement} */(document.getElementById("search-input")).value=query;
      if (query.length >= 2) await doSearch(query);
      else document.getElementById("search-view").textContent="Search for a movie, show or person above.";
    }
  });
}

init();
