import { navigate, routerReady, tabPath } from "./router.js";
import { icon } from "./icons.js";
import { api, escHtml, posterUrl, year, getActiveFilters, getActiveGenre, getGenresCache, getCurrentTab, getSearchTimeout, setSearchTimeout } from "./state.js";
import { renderGrid, renderSkeletons, renderSliderCard, renderSliderSkeletons, addLoadMore, removeLoadMore, openMedia } from "./grid.js";

// ── Discover Page (Trending tab) ────────────

/**
 * @param {HTMLElement} view
 * @returns {Promise<void>}
 */
export async function loadDiscoverPage(view) {
  view.innerHTML = '<div class="spinner" style="width:24px;height:24px;margin:40px auto"></div>';

  const sections = [
    { title: "Trending now", endpoint: "/api/trending?page=1", key: "trending" },
    { title: "Fresh in your library", endpoint: "/api/recently-added?page=1", key: "recently-added" },
    { title: "Popular Movies", endpoint: "/api/discover/movie?page=1&sortBy=popularity.desc", key: "popular-movies" },
    { title: "Popular TV Shows", endpoint: "/api/discover/tv?page=1&sortBy=popularity.desc", key: "popular-tv" },
    { title: "Upcoming Movies", endpoint: "/api/discover/upcoming/movie?page=1", key: "upcoming-movies" },
    { title: "Upcoming TV Shows", endpoint: "/api/discover/upcoming/tv?page=1", key: "upcoming-tv" },
  ];

  view.innerHTML = '<div id="discover-spotlight" class="spotlight-placeholder skeleton" aria-label="Loading featured title"></div>';

  for (const section of sections) {
    const container = document.createElement("div");
    container.className = "slider-section";
    container.id = `discover-${section.key}`;
    container.innerHTML = `
      <div class="slider-header">
        <span class="slider-title">${section.title}</span>
      </div>
      <div class="slider-row">${renderSliderSkeletons()}</div>`;
    view.appendChild(container);

    // Load each section async
    loadDiscoverSection(section, container);
  }
}

/**
 * @param {{ title: string, endpoint: string, key: string }} section
 * @param {HTMLElement} container
 * @returns {Promise<void>}
 */
export async function loadDiscoverSection(section, container) {
  const retry = /** @type {HTMLButtonElement | null} */(container.querySelector("[data-retry-section]"));
  if (retry) { retry.disabled=true; retry.textContent="Loading…"; }
  try {
    const data = await api(section.endpoint);
    if (!container.isConnected) return;
    const items = (data.results ?? []).filter((r) => r.mediaType !== "person").slice(0, 20);
    const row = container.querySelector(".slider-row");
    row.innerHTML = "";

    if (items.length === 0) {
      if (section.key === "trending") document.getElementById("discover-spotlight")?.remove();
      container.style.display = "none";
      return;
    }

    if (section.key === "trending") {
      let host = document.getElementById("discover-spotlight");
      if (!host) { host=document.createElement("div"); host.id="discover-spotlight"; container.before(host); }
      const featured = items.find(item => item.backdropPath) ?? items[0];
      if (host && featured) {
        host.className = "spotlight-host";
        host.innerHTML = `<button class="spotlight" aria-label="View ${escHtml(featured.title ?? featured.name)}"><img src="${posterUrl(featured.backdropPath ?? featured.posterPath, "w1280")}" alt=""><span class="spotlight-scrim"></span><span class="spotlight-copy"><span class="spotlight-eyebrow">In the spotlight</span><span class="spotlight-title">${escHtml(featured.title ?? featured.name)}</span><span class="spotlight-meta">${year(featured.releaseDate ?? featured.firstAirDate)} · ${featured.mediaType === "tv" ? "TV series" : "Movie"}</span></span><span class="spotlight-open">${icon("arrow",24)}</span></button>`;
        const image = host.querySelector("img");
        image.onerror = () => { image.style.visibility = "hidden"; };
        host.querySelector("button").onclick = () => openMedia(featured.mediaType, featured.id);
      }
    }
    for (const item of items) {
      row.appendChild(renderSliderCard(item));
    }
  } catch {
    if (!container.isConnected) return;
    if (section.key === "trending") document.getElementById("discover-spotlight")?.remove();
    container.querySelector(".slider-row").innerHTML = '<div class="empty" role="status">This section is temporarily unavailable.<br><button class="quick-btn secondary" data-retry-section>Try again</button></div>';
    container.querySelector("[data-retry-section]").addEventListener("click",()=>loadDiscoverSection(section,container));
  }
}

// ── Genre Browsing ───────────────────────────

/**
 * @param {string} type
 * @param {HTMLElement} view
 * @returns {Promise<void>}
 */
export async function loadGenreView(type, view) {
  const genresCache = getGenresCache();
  const activeGenre = getActiveGenre();

  // Build the chrome (filter bar + genre chips) only once
  if (!view.querySelector(`#${type}-filter-bar`)) {
    view.innerHTML = "";

    // Anime uses TV genres from the API
    const genreKey = type === "anime" ? "tv" : type;
    if (!genresCache[genreKey]) {
      try {
        genresCache[genreKey] = await api(`/api/genres/${genreKey}`);
      } catch {
        view.innerHTML = '<div class="empty" role="status">Categories are temporarily unavailable.<br><button class="quick-btn secondary">Try again</button></div>';
        view.querySelector("button").onclick=()=>loadGenreView(type,view);
        return;
      }
    }
    if (type === "anime" && !genresCache.anime) {
      genresCache.anime = genresCache.tv;
    }

    // Filter bar (rebuilt in-place on state changes)
    const filterBar = document.createElement("div");
    filterBar.className = "filter-bar";
    filterBar.id = `${type}-filter-bar`;
    view.appendChild(filterBar);

    // Genre chips (stable, only toggle .active class)
    const chips = document.createElement("div");
    chips.className = "genre-chips";
    chips.id = `${type}-genre-chips`;
    for (const g of genresCache[type]) {
      const chip = document.createElement("button");
      chip.className = "genre-chip";
      chip.dataset.genreId = String(g.id);
      chip.textContent = g.name;
      chip.onclick = () => {
        activeGenre[type] = activeGenre[type] === g.id ? null : g.id;
        updateGenreChipStates(type);
        loadDiscover(type, view);
      };
      chips.appendChild(chip);
    }
    view.appendChild(chips);

    const content = document.createElement("div");
    content.id = `${type}-content`;
    view.appendChild(content);
  }

  refreshFilterBar(type, view);
  updateGenreChipStates(type);
  await loadDiscover(type, view);
}

/**
 * @param {string} type
 * @param {HTMLElement} view
 * @returns {void}
 */
export function refreshFilterBar(type, view) {
  const activeFilters = getActiveFilters();
  const bar = document.getElementById(`${type}-filter-bar`);
  bar.innerHTML = "";

  const filterBtn = document.createElement("button");
  filterBtn.className = "filter-btn" + (hasActiveFilters(type) ? " active" : "");
  filterBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z"/></svg> Filters${hasActiveFilters(type) ? " ●" : ""}`;
  filterBtn.onclick = () => showFilterDropdown(type, view);
  bar.appendChild(filterBtn);

  const sortOptions = [
    { label: "Popular", value: "popularity.desc" },
    { label: "Top Rated", value: "vote_average.desc" },
    { label: "Newest", value: type === "movie" ? "primary_release_date.desc" : "first_air_date.desc" },
  ];

  for (const opt of sortOptions) {
    const btn = document.createElement("button");
    const currentSort = activeFilters[type].sortBy ?? "popularity.desc";
    btn.className = "filter-btn" + (currentSort === opt.value ? " active" : "");
    btn.textContent = opt.label;
    btn.onclick = () => {
      activeFilters[type].sortBy = opt.value;
      refreshFilterBar(type, view);
      loadDiscover(type, view);
    };
    bar.appendChild(btn);
  }
}

/**
 * @param {string} type
 * @returns {void}
 */
export function updateGenreChipStates(type) {
  const activeGenre = getActiveGenre();
  const container = document.getElementById(`${type}-genre-chips`);
  if (!container) return;
  container.querySelectorAll(".genre-chip").forEach((chip) => {
    chip.classList.toggle("active", Number(/** @type {HTMLElement} */ (chip).dataset.genreId) === activeGenre[type]);
  });
}

/**
 * @param {string} type
 * @returns {boolean}
 */
export function hasActiveFilters(type) {
  const f = getActiveFilters()[type];
  return !!(f.yearFrom || f.yearTo || f.ratingFrom || f.ratingTo);
}

const ANIME_KEYWORD = "210024";

/**
 * @param {string} type
 * @returns {string}
 */
export function buildDiscoverParams(type) {
  const params = new URLSearchParams();
  const activeGenre = getActiveGenre();
  const f = getActiveFilters()[type];
  if (activeGenre[type]) params.set("genre", String(activeGenre[type]));
  if (f.sortBy) params.set("sortBy", f.sortBy);

  const isDateMovie = type === "movie";
  if (f.yearFrom) {
    const key = isDateMovie ? "primaryReleaseDateGte" : "firstAirDateGte";
    params.set(key, `${f.yearFrom}-01-01`);
  }
  if (f.yearTo) {
    const key = isDateMovie ? "primaryReleaseDateLte" : "firstAirDateLte";
    params.set(key, `${f.yearTo}-12-31`);
  }
  if (f.ratingFrom) params.set("voteAverageGte", f.ratingFrom);
  if (f.ratingTo) params.set("voteAverageLte", f.ratingTo);

  // Anime tab: only show anime via TMDB keyword
  if (type === "anime") params.set("keywords", ANIME_KEYWORD);

  return params.toString();
}

const discoverVersions = new WeakMap();
/**
 * @param {string} type
 * @param {HTMLElement} view
 * @returns {Promise<void>}
 */
export async function loadDiscover(type, view) {
  const version=(discoverVersions.get(view) ?? 0)+1; discoverVersions.set(view,version);
  const content = document.getElementById(`${type}-content`);
  renderSkeletons(content);

  const filterParams = buildDiscoverParams(type);
  // Anime uses the TV discover endpoint
  const apiType = type === "anime" ? "tv" : type;

  try {
    const data = await api(`/api/discover/${apiType}?page=1&${filterParams}`);
    if (discoverVersions.get(view)!==version) return;
    content.innerHTML = "";
    if (!data.results.length) { content.innerHTML='<div class="empty" role="status">No titles match these filters. Try another genre or reset your filters.</div>'; return; }
    renderGrid(data.results, content);
    if (data.totalPages > 1) {
      let page = 1;
      addLoadMore(content, async () => {
        const nextPage=page+1;
        const more = await api(`/api/discover/${apiType}?page=${nextPage}&${filterParams}`);
        if (discoverVersions.get(view)!==version) return;
        page=nextPage;
        renderGrid(more.results, content, true);
        if (page >= more.totalPages) removeLoadMore(content);
      });
    }
  } catch {
    if (discoverVersions.get(view)!==version) return;
    content.innerHTML = '<div class="empty" role="status">Titles are temporarily unavailable.<br><button class="quick-btn secondary">Try again</button></div>';
    content.querySelector("button").onclick=()=>loadDiscover(type,view);
  }
}

/**
 * @param {string} type
 * @param {HTMLElement} view
 * @returns {void}
 */
export function showFilterDropdown(type, view) {
  const activeFilters = getActiveFilters();
  const f = activeFilters[type];

  document.getElementById("filter-dialog")?.remove();
  const dropdown = document.createElement("dialog");
  dropdown.className = "filter-dropdown";
  dropdown.id = "filter-dialog";
  dropdown.setAttribute("aria-labelledby","filter-dialog-title");
  const trigger = /** @type {HTMLElement} */(view.querySelector(".filter-btn"));
  dropdown.addEventListener("close",()=>{
    dropdown.remove();
    const next = trigger?.isConnected ? trigger : /** @type {HTMLElement} */(view.querySelector(".filter-btn"));
    if (next?.getClientRects().length) next.focus();
  });
  dropdown.addEventListener("click",event=>{
    if(event.target !== dropdown) return;
    const r=dropdown.getBoundingClientRect();
    if(event.clientX<r.left || event.clientX>r.right || event.clientY<r.top || event.clientY>r.bottom) dropdown.close();
  });
  dropdown.innerHTML = `
    <header class="filter-dialog-header"><h2 class="filter-dropdown-title" id="filter-dialog-title">Filters</h2><button type="button" class="quick-btn secondary" id="filter-close" aria-label="Close filters">✕</button></header>
    <div class="filter-group">
      <div class="filter-group-label">Year Range</div>
      <div class="filter-range-row">
        <input type="number" id="filter-year-from" aria-label="From year" placeholder="From (e.g. 2000)" min="1900" max="2030" value="${f.yearFrom ?? ""}">
        <input type="number" id="filter-year-to" aria-label="To year" placeholder="To (e.g. 2025)" min="1900" max="2030" value="${f.yearTo ?? ""}">
      </div>
    </div>
    <div class="filter-group">
      <div class="filter-group-label">Rating Range (0-10)</div>
      <div class="filter-range-row">
        <input type="number" id="filter-rating-from" aria-label="Minimum rating" placeholder="Min" min="0" max="10" step="0.5" value="${f.ratingFrom ?? ""}">
        <input type="number" id="filter-rating-to" aria-label="Maximum rating" placeholder="Max" min="0" max="10" step="0.5" value="${f.ratingTo ?? ""}">
      </div>
    </div>
    <div class="filter-actions">
      <button class="filter-reset-btn" id="filter-reset">Reset</button>
      <button class="filter-apply-btn" id="filter-apply">Apply</button>
    </div>`;

  document.body.appendChild(dropdown);
  dropdown.showModal();
  document.getElementById("filter-close").onclick = () => dropdown.close();

  document.getElementById("filter-apply").onclick = () => {
    activeFilters[type].yearFrom = /** @type {HTMLInputElement} */ (document.getElementById("filter-year-from")).value || undefined;
    activeFilters[type].yearTo = /** @type {HTMLInputElement} */ (document.getElementById("filter-year-to")).value || undefined;
    activeFilters[type].ratingFrom = /** @type {HTMLInputElement} */ (document.getElementById("filter-rating-from")).value || undefined;
    activeFilters[type].ratingTo = /** @type {HTMLInputElement} */ (document.getElementById("filter-rating-to")).value || undefined;
    dropdown.close();
    loadGenreView(type, view);
  };

  document.getElementById("filter-reset").onclick = () => {
    activeFilters[type] = {};
    dropdown.close();
    loadGenreView(type, view);
  };
}

// ── Search ───────────────────────────────────

/** @returns {void} */
export function initSearch() {
  const searchInput = /** @type {HTMLInputElement} */ (document.getElementById("search-input"));

  searchInput.addEventListener("input", () => {
    clearTimeout(getSearchTimeout());
    const q = searchInput.value.trim();

    if (q.length < 2) {
      if (routerReady() && location.pathname === "/search") { navigate(tabPath(getCurrentTab()), {replace:true}); return; }
      document.getElementById("search-view").classList.remove("active");
      document.getElementById(`${getCurrentTab()}-view`).classList.add("active");
      return;
    }

    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.getElementById("search-view").classList.add("active");

    setSearchTimeout(setTimeout(() => routerReady() ? navigate("/search", {replace:location.pathname === "/search",query:q}) : doSearch(q), 350));
  });
}

/**
 * @param {string} q
 * @returns {Promise<void>}
 */
export async function doSearch(q) {
  const view = document.getElementById("search-view");
  renderSkeletons(view);

  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (routerReady() && (location.pathname !== "/search" || document.getElementById("search-input")["value"] !== q)) return;
    view.innerHTML = "";
    if (data.results.length === 0) {
      view.innerHTML = `<div class="empty">No results for "${escHtml(q)}"</div>`;
      return;
    }
    renderGrid(data.results, view);
  } catch {
    view.innerHTML = '<div class="empty">Search failed</div>';
  }
}
