// ── Telegram Web App ─────────────────────────

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const initData = tg?.initData ?? "";
const isTelegramWebApp = !!initData;
const TMDB_IMG = "https://image.tmdb.org/t/p";

// ── State ────────────────────────────────────

let currentTab = "trending";
let currentDetail = null;
let selectedSeasons = new Set();
let genresCache = { movie: null, tv: null, anime: null };
let activeGenre = { movie: null, tv: null, anime: null };
let trendingPage = 1;
let searchTimeout = null;
let previousView = "trending";
let userState = null; // { linked, seerrUserId, seerrUsername, isAdmin, telegramUserId }
let activeFilters = { movie: {}, tv: {}, anime: {} };
let navigationStack = []; // for nested back navigation (person -> detail -> list)

// ── Auth ─────────────────────────────────────

function getAuthHeaders() {
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

async function api(path) {
  const res = await fetch(path, {
    headers: getAuthHeaders(),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
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

function posterUrl(path, size = "w342") {
  if (!path) return "";
  return `${TMDB_IMG}/${size}${path}`;
}

function year(date) {
  return date ? date.slice(0, 4) : "????";
}

function statusBadge(mediaInfo) {
  if (!mediaInfo) return "";
  switch (mediaInfo.status) {
    case 5: return '<span class="badge badge-available">Available</span>';
    case 2: return '<span class="badge badge-requested">Requested</span>';
    case 3: return '<span class="badge badge-downloading">Downloading</span>';
    case 4: return '<span class="badge badge-requested">Partial</span>';
    default: return "";
  }
}

function statusText(status) {
  switch (status) {
    case 5: return "Available";
    case 4: return "Partially available";
    case 3: return "Downloading";
    case 2: return "Requested";
    default: return "Not in library";
  }
}

function statusIcon(status) {
  switch (status) {
    case 5: return "&#9989;";
    case 4: return "&#128993;";
    case 3: return "&#9881;&#65039;";
    case 2: return "&#9203;";
    default: return "&#128308;";
  }
}

function requestStatusText(status) {
  switch (status) {
    case 1: return "Pending";
    case 2: return "Approved";
    case 3: return "Declined";
    case 4: return "Failed";
    case 5: return "Available";
    default: return "Unknown";
  }
}

function requestStatusClass(status) {
  switch (status) {
    case 1: return "badge-requested";
    case 2: return "badge-approved";
    case 3: return "badge-declined";
    case 4: return "badge-declined";
    case 5: return "badge-available";
    default: return "";
  }
}

function showLoading() { document.getElementById("loading").classList.remove("hidden"); }
function hideLoading() { document.getElementById("loading").classList.add("hidden"); }

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── Grid Rendering ───────────────────────────

function renderGrid(items, container, append = false) {
  const grid = append
    ? container.querySelector(".media-grid") ?? document.createElement("div")
    : document.createElement("div");
  if (!append) grid.className = "media-grid";

  const html = items
    .filter((r) => r.mediaType !== "person")
    .map((r) => {
      const name = r.title ?? r.name ?? "Unknown";
      const y = year(r.releaseDate ?? r.firstAirDate);
      const badge = statusBadge(r.mediaInfo);
      const poster = r.posterPath
        ? `<img src="${posterUrl(r.posterPath, "w342")}" alt="" loading="lazy">`
        : "";
      const rating = r.voteAverage
        ? `<div class="card-rating">&#11088; ${r.voteAverage.toFixed(1)}</div>`
        : "";

      return `
        <div class="media-card" data-type="${r.mediaType}" data-id="${r.id}">
          ${poster}
          ${badge}
          <div class="card-title">
            ${escHtml(name)} (${y})
            ${rating}
          </div>
        </div>`;
    })
    .join("");

  if (append) {
    grid.insertAdjacentHTML("beforeend", html);
  } else {
    grid.innerHTML = html;
  }

  if (!append) container.appendChild(grid);

  grid.querySelectorAll(".media-card").forEach((card) => {
    card.onclick = () => openDetail(card.dataset.type, Number(card.dataset.id));
  });
}

function renderSkeletons(container, count = 9) {
  const grid = document.createElement("div");
  grid.className = "media-grid";
  for (let i = 0; i < count; i++) {
    grid.innerHTML += '<div class="skeleton skeleton-card"></div>';
  }
  container.innerHTML = "";
  container.appendChild(grid);
}

// ── Tab Navigation ───────────────────────────

function initTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => switchTab(tab.dataset.tab);
  });
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));

  const viewId = `${tab}-view`;
  document.getElementById(viewId).classList.add("active");
  previousView = tab;

  removeRequestBar();

  // Clear search when switching tabs
  const searchInput = document.getElementById("search-input");
  if (searchInput.value.trim().length > 0) {
    searchInput.value = "";
  }

  const view = document.getElementById(viewId);
  if (!view.children.length || (view.children.length === 1 && view.querySelector(".skeleton"))) {
    loadTabContent(tab);
  }

  if (tg) tg.BackButton.hide();
}

async function loadTabContent(tab) {
  const view = document.getElementById(`${tab}-view`);

  if (tab === "trending") {
    await loadDiscoverPage(view);
  }

  if (tab === "movies" || tab === "tv" || tab === "anime") {
    const type = tab === "movies" ? "movie" : tab === "anime" ? "anime" : "tv";
    await loadGenreView(type, view);
  }

  if (tab === "requests") {
    await loadRequests(view);
  }
}

// ── Discover Page (Trending tab) ────────────

async function loadDiscoverPage(view) {
  view.innerHTML = '<div class="spinner" style="width:24px;height:24px;margin:40px auto"></div>';

  const sections = [
    { title: "Trending", endpoint: "/api/trending?page=1", key: "trending" },
    { title: "Recently Added", endpoint: "/api/recently-added?page=1", key: "recently-added" },
    { title: "Popular Movies", endpoint: "/api/discover/movie?page=1&sortBy=popularity.desc", key: "popular-movies" },
    { title: "Popular TV Shows", endpoint: "/api/discover/tv?page=1&sortBy=popularity.desc", key: "popular-tv" },
    { title: "Upcoming Movies", endpoint: "/api/discover/upcoming/movie?page=1", key: "upcoming-movies" },
    { title: "Upcoming TV Shows", endpoint: "/api/discover/upcoming/tv?page=1", key: "upcoming-tv" },
  ];

  view.innerHTML = "";

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

function renderSliderSkeletons() {
  let html = "";
  for (let i = 0; i < 6; i++) {
    html += '<div class="slider-card"><div class="skeleton" style="width:120px;height:180px;border-radius:var(--radius)"></div></div>';
  }
  return html;
}

async function loadDiscoverSection(section, container) {
  try {
    const data = await api(section.endpoint);
    const items = (data.results ?? []).filter((r) => r.mediaType !== "person").slice(0, 20);
    const row = container.querySelector(".slider-row");
    row.innerHTML = "";

    if (items.length === 0) {
      container.style.display = "none";
      return;
    }

    for (const item of items) {
      row.appendChild(renderSliderCard(item));
    }
  } catch {
    container.querySelector(".slider-row").innerHTML = '<div class="empty" style="padding:12px;font-size:12px">Failed to load</div>';
  }
}

function renderSliderCard(item) {
  const card = document.createElement("div");
  card.className = "slider-card";
  const name = item.title ?? item.name ?? "Unknown";
  const y = year(item.releaseDate ?? item.firstAirDate);
  const badge = statusBadge(item.mediaInfo);

  card.innerHTML = `
    <div class="slider-card-img-wrap">
      ${item.posterPath ? `<img class="slider-card-poster" src="${posterUrl(item.posterPath, "w185")}" alt="" loading="lazy">` : '<div class="slider-card-poster"></div>'}
      ${badge}
    </div>
    <div class="slider-card-title">${escHtml(name)}</div>
    <div class="slider-card-sub">${y}</div>`;

  card.onclick = () => openDetail(item.mediaType, item.id);
  return card;
}

// ── Genre Browsing ───────────────────────────

async function loadGenreView(type, view) {
  // Build the chrome (filter bar + genre chips) only once
  if (!view.querySelector(`#${type}-filter-bar`)) {
    view.innerHTML = "";

    // Anime uses TV genres from the API
    const genreKey = type === "anime" ? "tv" : type;
    if (!genresCache[genreKey]) {
      try {
        genresCache[genreKey] = await api(`/api/genres/${genreKey}`);
      } catch {
        view.innerHTML = '<div class="empty">Failed to load genres</div>';
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

function refreshFilterBar(type, view) {
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

function updateGenreChipStates(type) {
  const container = document.getElementById(`${type}-genre-chips`);
  if (!container) return;
  container.querySelectorAll(".genre-chip").forEach((chip) => {
    chip.classList.toggle("active", Number(chip.dataset.genreId) === activeGenre[type]);
  });
}

function hasActiveFilters(type) {
  const f = activeFilters[type];
  return f.yearFrom || f.yearTo || f.ratingFrom || f.ratingTo;
}

const ANIME_KEYWORD = "210024";

function buildDiscoverParams(type) {
  const params = new URLSearchParams();
  const f = activeFilters[type];
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

async function loadDiscover(type, view) {
  const content = document.getElementById(`${type}-content`);
  renderSkeletons(content);

  const filterParams = buildDiscoverParams(type);
  // Anime uses the TV discover endpoint
  const apiType = type === "anime" ? "tv" : type;

  try {
    const data = await api(`/api/discover/${apiType}?page=1&${filterParams}`);
    content.innerHTML = "";
    renderGrid(data.results, content);
    if (data.totalPages > 1) {
      let page = 1;
      addLoadMore(content, async () => {
        page++;
        const more = await api(`/api/discover/${apiType}?page=${page}&${filterParams}`);
        renderGrid(more.results, content, true);
        if (page >= more.totalPages) removeLoadMore(content);
      });
    }
  } catch {
    content.innerHTML = '<div class="empty">Failed to load</div>';
  }
}

function showFilterDropdown(type, view) {
  const f = activeFilters[type];

  const overlay = document.createElement("div");
  overlay.className = "filter-overlay";
  overlay.onclick = () => { overlay.remove(); dropdown.remove(); };
  document.body.appendChild(overlay);

  const dropdown = document.createElement("div");
  dropdown.className = "filter-dropdown";
  dropdown.innerHTML = `
    <div class="filter-dropdown-title">Filters</div>
    <div class="filter-group">
      <div class="filter-group-label">Year Range</div>
      <div class="filter-range-row">
        <input type="number" id="filter-year-from" placeholder="From (e.g. 2000)" min="1900" max="2030" value="${f.yearFrom ?? ""}">
        <input type="number" id="filter-year-to" placeholder="To (e.g. 2025)" min="1900" max="2030" value="${f.yearTo ?? ""}">
      </div>
    </div>
    <div class="filter-group">
      <div class="filter-group-label">Rating Range (0-10)</div>
      <div class="filter-range-row">
        <input type="number" id="filter-rating-from" placeholder="Min" min="0" max="10" step="0.5" value="${f.ratingFrom ?? ""}">
        <input type="number" id="filter-rating-to" placeholder="Max" min="0" max="10" step="0.5" value="${f.ratingTo ?? ""}">
      </div>
    </div>
    <div class="filter-actions">
      <button class="filter-reset-btn" id="filter-reset">Reset</button>
      <button class="filter-apply-btn" id="filter-apply">Apply</button>
    </div>`;

  document.body.appendChild(dropdown);

  document.getElementById("filter-apply").onclick = () => {
    activeFilters[type].yearFrom = document.getElementById("filter-year-from").value || undefined;
    activeFilters[type].yearTo = document.getElementById("filter-year-to").value || undefined;
    activeFilters[type].ratingFrom = document.getElementById("filter-rating-from").value || undefined;
    activeFilters[type].ratingTo = document.getElementById("filter-rating-to").value || undefined;
    overlay.remove();
    dropdown.remove();
    loadGenreView(type, view);
  };

  document.getElementById("filter-reset").onclick = () => {
    activeFilters[type] = {};
    overlay.remove();
    dropdown.remove();
    loadGenreView(type, view);
  };
}

// ── Search ───────────────────────────────────

function initSearch() {
  const searchInput = document.getElementById("search-input");

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    const q = searchInput.value.trim();

    if (q.length < 2) {
      document.getElementById("search-view").classList.remove("active");
      document.getElementById(`${currentTab}-view`).classList.add("active");
      return;
    }

    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.getElementById("search-view").classList.add("active");

    searchTimeout = setTimeout(() => doSearch(q), 350);
  });
}

async function doSearch(q) {
  const view = document.getElementById("search-view");
  renderSkeletons(view);

  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
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

// ── My Requests ─────────────────────────────

async function loadRequests(view) {
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

function renderRequestList(items, container, append = false) {
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
    const mediaStatusCls = item.mediaStatus === 5 ? "badge-available" : "";

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

// ── Detail View ──────────────────────────────

async function openDetail(type, id) {
  showLoading();
  removeRequestBar();

  try {
    const data = await api(`/api/${type}/${id}`);
    currentDetail = { type, id, data };
    selectedSeasons = new Set();
    renderDetail(type, data);
  } catch {
    toast("Failed to load details");
  } finally {
    hideLoading();
  }
}

function getTrailerUrl(d) {
  const vids = d.relatedVideos ?? [];
  const trailer = vids.find((v) => v.site === "YouTube" && v.type === "Trailer")
    ?? vids.find((v) => v.site === "YouTube");
  return trailer ? `https://youtube.com/watch?v=${trailer.key}` : null;
}

function getImdbUrl(d) {
  const id = d.externalIds?.imdbId;
  return id ? `https://www.imdb.com/title/${id}/` : null;
}

function getCertification(d, type) {
  if (type === "movie") {
    const us = d.releases?.results?.find((r) => r.iso_3166_1 === "US");
    return us?.release_dates?.find((rd) => rd.certification)?.certification || null;
  }
  const us = d.contentRatings?.results?.find((r) => r.iso_3166_1 === "US");
  return us?.rating || null;
}

function renderDetail(type, d) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const view = document.getElementById("detail-view");
  view.classList.add("active");

  const name = d.title ?? d.name ?? "Unknown";
  const y = year(d.releaseDate ?? d.firstAirDate);
  const status = d.mediaInfo?.status ?? 1;
  const overview = d.overview ?? "";
  const cert = getCertification(d, type);
  const director = d.credits?.crew?.find((c) => c.job === "Director")?.name;
  const creators = (d.createdBy ?? []).slice(0, 2).map((c) => c.name);
  const cast = (d.credits?.cast ?? []).slice(0, 10);
  const network = d.networks?.[0]?.name;
  const trailerUrl = getTrailerUrl(d);
  const imdbUrl = getImdbUrl(d);
  const genres = (d.genres ?? []).slice(0, 4);

  let meta = [];
  if (d.voteAverage) meta.push(`<span class="pill">&#11088; ${d.voteAverage.toFixed(1)}</span>`);
  if (cert) meta.push(`<span class="pill">${escHtml(cert)}</span>`);
  if (type === "movie" && d.runtime) meta.push(`<span class="pill">${d.runtime} min</span>`);
  if (type === "tv" && d.numberOfSeasons) meta.push(`<span class="pill">${d.numberOfSeasons} Season${d.numberOfSeasons > 1 ? "s" : ""}</span>`);
  if (type === "tv" && d.episodeRunTime?.[0]) meta.push(`<span class="pill">${d.episodeRunTime[0]}m/ep</span>`);
  if (network) meta.push(`<span class="pill">${escHtml(network)}</span>`);
  if (d.status) meta.push(`<span class="pill">${escHtml(d.status)}</span>`);

  let links = "";
  if (trailerUrl || imdbUrl) {
    links = '<div class="detail-links">';
    if (trailerUrl) links += `<a class="detail-link" href="${trailerUrl}" target="_blank">&#9654;&#65039; Trailer</a>`;
    if (imdbUrl) links += `<a class="detail-link" href="${imdbUrl}" target="_blank">&#127902; IMDB</a>`;
    links += "</div>";
  }

  let genreTags = "";
  if (genres.length) {
    genreTags = '<div class="detail-genres">' +
      genres.map((g) => `<span class="detail-genre-tag">${escHtml(g.name)}</span>`).join("") +
      "</div>";
  }

  // Watch providers
  let providersHtml = "";
  const providers = extractWatchProviders(d.watchProviders);
  if (providers.length) {
    providersHtml = '<div class="watch-providers"><div class="watch-providers-title">Streaming On</div><div class="provider-row">';
    providersHtml += providers.map((p) =>
      `<img class="provider-logo" src="${TMDB_IMG}/w92${p.logoPath}" alt="${escHtml(p.name)}" title="${escHtml(p.name)}">`
    ).join("");
    providersHtml += "</div></div>";
  }

  let creditsHtml = "";
  if (director || creators.length) {
    creditsHtml = '<div class="detail-section">';
    if (director) creditsHtml += `<div class="detail-section-title">Director</div><div class="detail-section-content">${escHtml(director)}</div>`;
    if (creators.length) creditsHtml += `<div class="detail-section-title">Created by</div><div class="detail-section-content">${creators.map(escHtml).join(", ")}</div>`;
    creditsHtml += "</div>";
  }

  let html = `
    <div class="back-row">
      <button class="back-btn" id="back-btn">&#8592; Back</button>
    </div>
    <div class="detail-header">
      ${d.backdropPath
        ? `<img class="detail-backdrop" src="${posterUrl(d.backdropPath, "w500")}" alt="">`
        : '<div class="detail-backdrop" style="background:var(--muted)"></div>'}
      <div class="detail-backdrop-gradient"></div>
    </div>
    <div class="detail-poster-row">
      ${d.posterPath
        ? `<img class="detail-poster" src="${posterUrl(d.posterPath, "w342")}" alt="">`
        : ""}
      <div class="detail-title-block">
        <div class="detail-title">${escHtml(name)}</div>
        <div class="detail-year">${y}</div>
      </div>
    </div>
    ${d.tagline ? `<div class="detail-tagline">${escHtml(d.tagline)}</div>` : ""}
    <div class="detail-meta">${meta.join("")}</div>
    ${genreTags}
    <div class="detail-status">${statusIcon(status)} ${statusText(status)}</div>
    ${providersHtml}
    ${links}
    ${overview ? `<div class="detail-overview">${escHtml(overview)}</div>` : ""}
    ${creditsHtml}
    ${cast.length ? renderCastGrid(cast) : ""}
    <div id="detail-recommendations"></div>
    <div id="detail-similar"></div>`;

  if (type === "movie") {
    view.innerHTML = html;
    if (status !== 5 && status !== 2 && status !== 3) {
      showRequestBar("Plunder It!", async () => {
        showLoading();
        const result = await apiPost("/api/request", {
          mediaType: "movie",
          mediaId: d.id,
          is4k: false,
        });
        hideLoading();
        if (result.success) {
          toast("Request submitted!");
          removeRequestBar();
          view.querySelector(".detail-status").innerHTML = "&#9203; Requested";
        } else {
          toast(formatError(result.error));
        }
      });
    }
  } else {
    html += renderSeasonPicker(d);
    view.innerHTML = html;
    attachSeasonHandlers(d, view);
    updateTvRequestBar(d);
  }

  document.getElementById("back-btn").onclick = goBack;

  // Attach cast card click handlers
  view.querySelectorAll(".cast-card").forEach((card) => {
    card.onclick = () => openPerson(Number(card.dataset.personId));
  });

  window.scrollTo(0, 0);

  if (tg) {
    tg.BackButton.show();
    tg.BackButton.onClick(goBack);
  }

  // Load recommendations and similar asynchronously
  loadDetailSlider(`/api/${type}/${d.id}/recommendations`, "detail-recommendations", "Recommendations");
  loadDetailSlider(`/api/${type}/${d.id}/similar`, "detail-similar", "Similar Titles");
}

function extractWatchProviders(watchProviders) {
  if (!watchProviders || !Array.isArray(watchProviders)) return [];
  // Seerr returns array of region-based providers; find US or first available
  for (const region of watchProviders) {
    const flat = region?.flatrate ?? [];
    if (flat.length) return flat;
  }
  // Try flatrate from any structure
  if (typeof watchProviders === "object" && !Array.isArray(watchProviders)) {
    const us = watchProviders.US ?? watchProviders.GB ?? Object.values(watchProviders)[0];
    return us?.flatrate ?? [];
  }
  return [];
}

function renderCastGrid(cast) {
  let html = '<div class="detail-section"><div class="detail-section-title">Cast</div></div><div class="cast-grid">';
  for (const c of cast) {
    const photo = c.profilePath
      ? `<img class="cast-photo" src="${TMDB_IMG}/w185${c.profilePath}" alt="" loading="lazy">`
      : '<div class="cast-photo cast-photo-empty">&#128100;</div>';
    html += `
      <div class="cast-card" data-person-id="${c.id}">
        ${photo}
        <div class="cast-name">${escHtml(c.name)}</div>
        <div class="cast-character">${escHtml(c.character || "")}</div>
      </div>`;
  }
  html += "</div>";
  return html;
}

async function loadDetailSlider(endpoint, containerId, title) {
  const container = document.getElementById(containerId);
  if (!container) return;

  try {
    const data = await api(endpoint);
    const items = (data.results ?? []).filter((r) => r.mediaType !== "person").slice(0, 15);
    if (items.length === 0) return;

    const section = document.createElement("div");
    section.className = "slider-section";
    section.innerHTML = `<div class="slider-header"><span class="slider-title">${title}</span></div>`;
    const row = document.createElement("div");
    row.className = "slider-row";
    for (const item of items) {
      row.appendChild(renderSliderCard(item));
    }
    section.appendChild(row);
    container.appendChild(section);
  } catch {
    // Silently fail for recommendations/similar
  }
}

function goBack() {
  document.getElementById("detail-view").classList.remove("active");
  removeRequestBar();
  navigationStack = [];

  const searchInput = document.getElementById("search-input");
  if (searchInput.value.trim().length >= 2) {
    document.getElementById("search-view").classList.add("active");
  } else {
    document.getElementById(`${currentTab}-view`).classList.add("active");
  }

  currentDetail = null;
  if (tg) tg.BackButton.hide();
}

// ── Season Picker ────────────────────────────

function renderSeasonPicker(show) {
  const seasons = show.seasons ?? [];
  const today = new Date().toISOString().slice(0, 10);

  let html = '<div class="season-picker"><h3>Pick yer seasons</h3><div class="season-grid">';

  for (const s of seasons) {
    if (s.seasonNumber === 0) continue;

    const sStatus = getSeasonState(show, s);
    let cls = "season-btn";
    let label = `S${s.seasonNumber}`;

    if (sStatus === "available") {
      cls += " available";
      label += " &#9989;";
    } else if (sStatus === "partial") {
      cls += " partial";
      label += " &#128993;";
    } else if (sStatus === "pending" || sStatus === "approved") {
      cls += " pending";
      label += " &#9203;";
    }

    html += `<button class="${cls}" data-season="${s.seasonNumber}" data-state="${sStatus}">${label}</button>`;
  }

  html += '</div><div class="quick-actions">';

  const requestable = seasons.filter((s) => s.seasonNumber !== 0 && getSeasonState(show, s) === "requestable");
  if (requestable.length > 0) {
    html += '<button class="quick-btn secondary" id="select-all">All Missing</button>';

    const future = requestable.filter((s) =>
      (s.airDate && s.airDate > today) || (!s.airDate && show.status === "Returning Series")
    );
    if (future.length > 0) {
      html += '<button class="quick-btn secondary" id="select-new">New Only</button>';
    }
  }

  html += '<button class="quick-btn secondary" id="clear-selection" style="display:none">Clear</button>';
  html += "</div></div>";

  return html;
}

function getSeasonState(show, season) {
  const mSeason = show.mediaInfo?.seasons?.find((ms) => ms.seasonNumber === season.seasonNumber);
  if (mSeason?.status === 5) return "available";
  if (mSeason?.status === 4) return "partial";

  const req = show.mediaInfo?.requests ?? [];
  const approved = req.find((r) => r.status === 2 && r.seasons?.some((rs) => rs.seasonNumber === season.seasonNumber));
  if (approved) return "approved";
  const pending = req.find((r) => r.status === 1 && r.seasons?.some((rs) => rs.seasonNumber === season.seasonNumber));
  if (pending) return "pending";

  return "requestable";
}

function attachSeasonHandlers(show, view) {
  view.querySelectorAll(".season-btn").forEach((btn) => {
    if (btn.dataset.state !== "requestable") return;
    btn.onclick = () => {
      const sn = Number(btn.dataset.season);
      if (selectedSeasons.has(sn)) {
        selectedSeasons.delete(sn);
        btn.classList.remove("selected");
      } else {
        selectedSeasons.add(sn);
        btn.classList.add("selected");
      }
      updateTvRequestBar(show);
      updateClearBtn();
    };
  });

  const selectAllBtn = document.getElementById("select-all");
  if (selectAllBtn) {
    selectAllBtn.onclick = () => {
      view.querySelectorAll('.season-btn[data-state="requestable"]').forEach((btn) => {
        selectedSeasons.add(Number(btn.dataset.season));
        btn.classList.add("selected");
      });
      updateTvRequestBar(show);
      updateClearBtn();
    };
  }

  const selectNewBtn = document.getElementById("select-new");
  if (selectNewBtn) {
    const today = new Date().toISOString().slice(0, 10);
    selectNewBtn.onclick = () => {
      for (const s of show.seasons) {
        if (s.seasonNumber === 0) continue;
        if (getSeasonState(show, s) !== "requestable") continue;
        const isFuture = (s.airDate && s.airDate > today) || (!s.airDate && show.status === "Returning Series");
        if (isFuture) {
          selectedSeasons.add(s.seasonNumber);
          const btn = view.querySelector(`.season-btn[data-season="${s.seasonNumber}"]`);
          if (btn) btn.classList.add("selected");
        }
      }
      updateTvRequestBar(show);
      updateClearBtn();
    };
  }

  const clearBtn = document.getElementById("clear-selection");
  if (clearBtn) {
    clearBtn.onclick = () => {
      selectedSeasons.clear();
      view.querySelectorAll(".season-btn.selected").forEach((b) => b.classList.remove("selected"));
      updateTvRequestBar(show);
      updateClearBtn();
    };
  }
}

function updateClearBtn() {
  const btn = document.getElementById("clear-selection");
  if (btn) btn.style.display = selectedSeasons.size > 0 ? "inline-block" : "none";
}

function updateTvRequestBar(show) {
  if (selectedSeasons.size === 0) {
    removeRequestBar();
    return;
  }

  const sorted = [...selectedSeasons].sort((a, b) => a - b);
  const label = sorted.map((n) => `S${n}`).join(", ");

  showRequestBar(`Plunder ${label}`, async () => {
    showLoading();
    const result = await apiPost("/api/request", {
      mediaType: "tv",
      mediaId: show.id,
      seasons: sorted,
      is4k: false,
    });
    hideLoading();
    if (result.success) {
      toast(`${label} requested!`);
      removeRequestBar();
      selectedSeasons.clear();
      openDetail("tv", show.id);
    } else {
      toast(formatError(result.error));
    }
  });
}

// ── Person View ─────────────────────────────

async function openPerson(personId) {
  showLoading();
  removeRequestBar();

  try {
    const data = await api(`/api/person/${personId}`);
    renderPerson(data);
  } catch {
    toast("Failed to load person");
  } finally {
    hideLoading();
  }
}

function renderPerson(person) {
  // Push current detail onto navigation stack for back
  if (currentDetail) {
    navigationStack.push({ type: currentDetail.type, id: currentDetail.id });
  }

  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  const view = document.getElementById("person-view");
  view.classList.add("active");

  const photo = person.profilePath
    ? `<img class="person-photo" src="${TMDB_IMG}/w342${person.profilePath}" alt="">`
    : '<div class="person-photo person-photo-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>';

  const age = person.birthday ? calcAge(person.birthday, person.deathday) : null;

  let metaHtml = "";
  if (person.birthday) metaHtml += `<div class="person-meta-item">Born: ${formatDate(person.birthday)}${age !== null ? ` (age ${age})` : ""}</div>`;
  if (person.deathday) metaHtml += `<div class="person-meta-item">Died: ${formatDate(person.deathday)}</div>`;
  if (person.placeOfBirth) metaHtml += `<div class="person-meta-item">${escHtml(person.placeOfBirth)}</div>`;

  const bio = person.biography ?? "";
  const shortBio = bio.length > 300;

  let html = `
    <div class="back-row">
      <button class="back-btn" id="person-back-btn">&#8592; Back</button>
    </div>
    <div class="person-header">
      ${photo}
      <div class="person-info">
        <div class="person-name">${escHtml(person.name)}</div>
        <div class="person-known-for">${escHtml(person.knownForDepartment || "")}</div>
        ${metaHtml}
      </div>
    </div>`;

  if (bio) {
    html += `
      <div class="person-bio" id="person-bio">
        ${shortBio ? escHtml(bio.slice(0, 300)) + "..." : escHtml(bio)}
      </div>`;
    if (shortBio) {
      html += `<div style="padding:0 16px 12px"><button class="person-bio-toggle" id="bio-toggle">Show more</button></div>`;
    }
  }

  html += '<div id="person-filmography"></div>';
  view.innerHTML = html;

  // Bio toggle
  if (shortBio) {
    let expanded = false;
    document.getElementById("bio-toggle").onclick = () => {
      expanded = !expanded;
      document.getElementById("person-bio").textContent = expanded ? bio : bio.slice(0, 300) + "...";
      document.getElementById("bio-toggle").textContent = expanded ? "Show less" : "Show more";
    };
  }

  // Back button
  document.getElementById("person-back-btn").onclick = goBackFromPerson;

  if (tg) {
    tg.BackButton.show();
    tg.BackButton.onClick(goBackFromPerson);
  }

  window.scrollTo(0, 0);

  // Load filmography
  loadFilmography(person);
}

function calcAge(birthday, deathday) {
  const end = deathday ? new Date(deathday) : new Date();
  const born = new Date(birthday);
  let age = end.getFullYear() - born.getFullYear();
  const m = end.getMonth() - born.getMonth();
  if (m < 0 || (m === 0 && end.getDate() < born.getDate())) age--;
  return age;
}

async function loadFilmography(person) {
  const container = document.getElementById("person-filmography");
  if (!container) return;

  const credits = person.combinedCredits?.cast ?? [];
  if (credits.length === 0) return;

  // Sort by popularity descending
  const sorted = [...credits]
    .filter((c) => c.mediaType === "movie" || c.mediaType === "tv")
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .slice(0, 30);

  if (sorted.length === 0) return;

  const section = document.createElement("div");
  section.className = "slider-section";
  section.innerHTML = '<div class="slider-header"><span class="slider-title">Known For</span></div>';
  const row = document.createElement("div");
  row.className = "slider-row";

  for (const item of sorted) {
    const card = document.createElement("div");
    card.className = "slider-card";
    const name = item.title ?? item.name ?? "Unknown";
    const y = year(item.releaseDate ?? item.firstAirDate);

    card.innerHTML = `
      <div class="slider-card-img-wrap">
        ${item.posterPath ? `<img class="slider-card-poster" src="${posterUrl(item.posterPath, "w185")}" alt="" loading="lazy">` : '<div class="slider-card-poster"></div>'}
      </div>
      <div class="slider-card-title">${escHtml(name)}</div>
      <div class="slider-card-sub">${escHtml(item.character || y)}</div>`;

    card.onclick = () => openDetail(item.mediaType, item.id);
    row.appendChild(card);
  }

  section.appendChild(row);
  container.appendChild(section);
}

function goBackFromPerson() {
  document.getElementById("person-view").classList.remove("active");

  if (navigationStack.length > 0) {
    const prev = navigationStack.pop();
    openDetail(prev.type, prev.id);
  } else {
    document.getElementById(`${currentTab}-view`).classList.add("active");
    if (tg) tg.BackButton.hide();
  }
}

// ── Request Bar ──────────────────────────────

function showRequestBar(label, handler) {
  removeRequestBar();
  const bar = document.createElement("div");
  bar.className = "request-bar";
  bar.id = "request-bar";
  bar.innerHTML = `<button>&#9875; ${escHtml(label)}</button>`;
  bar.querySelector("button").onclick = handler;
  document.body.appendChild(bar);
}

function removeRequestBar() {
  document.getElementById("request-bar")?.remove();
}

function formatError(error) {
  switch (error) {
    case "DUPLICATE": return "Already requested!";
    case "QUOTA": return "Quota exceeded";
    case "BLACKLISTED": return "Title is blacklisted";
    case "NO_PERMISSION": return "No permission";
    case "NO_SEASONS": return "Already requested or available";
    default: return "Something went wrong";
  }
}

// ── Profile View ─────────────────────────────

function initProfileBtn() {
  document.getElementById("profile-btn").onclick = () => showProfile();
}

async function showProfile() {
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
    document.getElementById(`${currentTab}-view`).classList.add("active");
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === currentTab));
  };

  if (tg) {
    tg.BackButton.show();
    tg.BackButton.onClick(() => {
      view.classList.remove("active");
      document.getElementById(`${currentTab}-view`).classList.add("active");
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === currentTab));
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

function renderQuotaBar(label, q) {
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

// ── Admin Panel ──────────────────────────────

async function showAdmin() {
  const view = document.getElementById("admin-view");
  view.innerHTML = `
    <div class="admin-section" id="admin-pending-section" style="display:none">
      <div class="admin-section-title">Pending Requests</div>
      <div id="admin-pending-list"></div>
    </div>
    <div class="admin-section">
      <div class="admin-section-title">Linked Users</div>
      <div id="admin-users-list"><div class="spinner" style="width:20px;height:20px;margin:16px auto"></div></div>
    </div>
    <div class="admin-section">
      <div class="admin-section-title">Link New User</div>
      <div class="admin-link-form">
        <input type="number" id="admin-tg-id" placeholder="Telegram User ID" class="admin-input">
        <button class="admin-btn" id="admin-show-seerr">Find Seerr Users</button>
      </div>
      <div id="seerr-users-list"></div>
    </div>
    <div class="admin-section" id="admin-ignored-section" style="display:none">
      <div class="admin-section-title admin-ignored-toggle" id="admin-ignored-toggle">Ignored Users <span class="admin-toggle-arrow">&#9654;</span></div>
      <div id="admin-ignored-list" style="display:none"></div>
    </div>`;

  document.getElementById("admin-show-seerr").onclick = () => loadSeerrUsers(1);
  document.getElementById("admin-ignored-toggle").onclick = () => {
    const list = document.getElementById("admin-ignored-list");
    const arrow = document.querySelector(".admin-toggle-arrow");
    const open = list.style.display !== "none";
    list.style.display = open ? "none" : "";
    arrow.textContent = open ? "\u25B6" : "\u25BC";
  };

  await Promise.all([loadAdminUsers(), loadPendingUsers(), loadIgnoredUsers()]);
}

async function loadAdminUsers() {
  const list = document.getElementById("admin-users-list");
  try {
    const users = await api("/api/admin/users");
    if (users.length === 0) {
      list.innerHTML = '<div class="empty" style="padding:12px">No linked users</div>';
      return;
    }
    list.innerHTML = users.map((u) => `
      <div class="admin-user-row">
        <div class="admin-user-info">
          <span class="admin-user-tg">TG: ${u.telegramUserId}</span>
          <span class="admin-user-seerr">${escHtml(u.seerrUsername)}</span>
        </div>
        <button class="admin-unlink-btn" data-tg-id="${u.telegramUserId}">Unlink</button>
      </div>`).join("");

    list.querySelectorAll(".admin-unlink-btn").forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm(`Unlink Telegram user ${btn.dataset.tgId}?`)) return;
        showLoading();
        await apiPost("/api/admin/unlink", { telegramUserId: Number(btn.dataset.tgId) });
        hideLoading();
        toast("User unlinked");
        loadAdminUsers();
      };
    });
  } catch {
    list.innerHTML = '<div class="empty" style="padding:12px">Failed to load users</div>';
  }
}

async function loadPendingUsers() {
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
      btn.onclick = () => {
        document.getElementById("admin-tg-id").value = btn.dataset.tgId;
        loadSeerrUsers(1);
        document.getElementById("seerr-users-list").scrollIntoView({ behavior: "smooth", block: "start" });
      };
    });

    list.querySelectorAll(".admin-ignore-btn").forEach((btn) => {
      btn.onclick = async () => {
        await apiPost("/api/admin/ignore", { telegramUserId: Number(btn.dataset.tgId) });
        toast("User ignored");
        loadPendingUsers();
        loadIgnoredUsers();
      };
    });
  } catch {
    section.style.display = "none";
  }
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

async function loadIgnoredUsers() {
  const section = document.getElementById("admin-ignored-section");
  const list = document.getElementById("admin-ignored-list");
  try {
    const ids = await api("/api/admin/ignored");
    if (ids.length === 0) {
      section.style.display = "none";
      return;
    }
    section.style.display = "";
    list.innerHTML = ids.map((id) => `
      <div class="admin-user-row">
        <div class="admin-user-info">
          <span class="admin-user-tg">TG: ${id}</span>
        </div>
        <button class="admin-unignore-btn" data-tg-id="${id}">Restore</button>
      </div>`).join("");

    list.querySelectorAll(".admin-unignore-btn").forEach((btn) => {
      btn.onclick = async () => {
        await apiPost("/api/admin/unignore", { telegramUserId: Number(btn.dataset.tgId) });
        toast("User restored — they can request access again");
        loadIgnoredUsers();
      };
    });
  } catch {
    section.style.display = "none";
  }
}

async function loadSeerrUsers(page) {
  const list = document.getElementById("seerr-users-list");
  const tgId = document.getElementById("admin-tg-id").value.trim();

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
      btn.onclick = async () => {
        if (!tgId) { toast("Enter a Telegram User ID first"); return; }
        showLoading();
        try {
          await apiPost("/api/admin/link", {
            telegramUserId: Number(tgId),
            seerrUserId: Number(btn.dataset.seerrId),
          });
          toast("User linked!");
          document.getElementById("admin-tg-id").value = "";
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
      btn.onclick = () => loadSeerrUsers(Number(btn.dataset.page));
    });
  } catch {
    list.innerHTML = '<div class="empty" style="padding:12px">Failed to load Seerr users</div>';
  }
}

// ── Unlinked View ────────────────────────────

function showUnlinked() {
  // Hide everything except unlinked view
  document.querySelector(".top-bar").style.display = "none";
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

function showLoginScreen() {
  document.querySelector(".top-bar").style.display = "none";
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

async function loadTelegramLoginWidget() {
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

// ── Load More Helper ─────────────────────────

function addLoadMore(container, handler) {
  removeLoadMore(container);
  const btn = document.createElement("button");
  btn.className = "load-more";
  btn.textContent = "Load more";
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Loading...";
    await handler();
    btn.disabled = false;
    btn.textContent = "Load more";
  };
  container.appendChild(btn);
}

function removeLoadMore(container) {
  container.querySelector(".load-more")?.remove();
}

// ── Init ─────────────────────────────────────

async function init() {
  // If not in Telegram and no saved login, show login screen
  if (!isTelegramWebApp && !localStorage.getItem("tg_login")) {
    userState = { linked: false, isAdmin: false, telegramUserId: 0 };
    showLoginScreen();
    return;
  }

  try {
    userState = await api("/api/me");
  } catch {
    // Auth failed — if browser login is stale, clear it and show login
    if (!isTelegramWebApp) {
      localStorage.removeItem("tg_login");
      userState = { linked: false, isAdmin: false, telegramUserId: 0 };
      showLoginScreen();
      return;
    }
    userState = { linked: false, isAdmin: false, telegramUserId: 0 };
  }

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

  // Load initial content
  loadTabContent("trending");

  // Load admin panel when admin tab is selected
  if (userState.isAdmin) {
    const origSwitchTab = switchTab;
    // Admin tab content loads on first switch
  }
}

// Override loadTabContent to handle admin
const _origLoadTabContent = loadTabContent;
async function loadTabContentWithAdmin(tab) {
  if (tab === "admin") {
    await showAdmin();
    return;
  }
  return _origLoadTabContent(tab);
}
// Patch
loadTabContent = loadTabContentWithAdmin;

init();
