import {
  tg, TMDB_IMG, api, apiPost,
  posterUrl, year, statusIcon, statusText, statusBadge,
  escHtml, formatDate, showLoading, hideLoading, toast,
  getCurrentTab, getCurrentDetail, setCurrentDetail,
  getSelectedSeasons, setSelectedSeasons,
  getNavigationStack, setNavigationStack, getCaps,
  clearProgressPolling, setProgressInterval,
} from "./state.js";
import { renderSliderCard, renderGrid } from "./grid.js";

// ── Download Progress ────────────────────────

/**
 * @param {{ available: boolean, items: Array<{percent: number, eta: string|null, status: string, title: string, sizeTotal: number, sizeDownloaded: number, episode?: {season: number, episode: number, title: string}}>, isSeasonPack: boolean }} progress
 * @param {string} type
 * @returns {string}
 */
function renderProgressSection(progress, type) {
  if (!progress.available || progress.items.length === 0) return "";

  let html = '<div class="download-progress">';
  html += '<div class="download-progress-title">Download Progress</div>';

  if (type === "tv" && progress.items.length > 1 && !progress.isSeasonPack) {
    for (const item of progress.items) {
      const epLabel = item.episode
        ? `S${String(item.episode.season).padStart(2, "0")}E${String(item.episode.episode).padStart(2, "0")}`
        : "";
      const epTitle = item.episode?.title ?? "";
      html += `
        <div class="download-item">
          <div class="download-item-header">
            <span class="download-ep-label">${epLabel}</span>
            <span class="download-ep-title">${escHtml(epTitle)}</span>
            <span class="download-percent">${item.percent}%</span>
          </div>
          <div class="download-bar-track">
            <div class="download-bar-fill ${item.status}" style="width:${item.percent}%"></div>
          </div>
          ${item.eta ? `<div class="download-eta">ETA: ${escHtml(item.eta)}</div>` : ""}
        </div>`;
    }
  } else {
    const item = progress.items[0];
    const statusLabel = item.status === "paused" ? " (Paused)"
      : item.status === "queued" ? " (Queued)"
      : item.status === "importing" ? " (Importing...)"
      : item.status === "stalled" ? " (Stalled)"
      : item.status === "failed" ? " (Failed)"
      : "";

    html += `
      <div class="download-item">
        <div class="download-item-header">
          <span class="download-percent">${item.percent}%${statusLabel}</span>
          ${item.eta ? `<span class="download-eta">ETA: ${escHtml(item.eta)}</span>` : ""}
        </div>
        <div class="download-bar-track">
          <div class="download-bar-fill ${item.status}" style="width:${item.percent}%"></div>
        </div>
        ${progress.isSeasonPack ? '<div class="download-note">Season pack</div>' : ""}
      </div>`;
  }

  html += "</div>";
  return html;
}

/**
 * @param {string} type
 * @param {number} tmdbId
 * @param {number} [tvdbId]
 * @returns {void}
 */
function startProgressPolling(type, tmdbId, tvdbId) {
  clearProgressPolling();

  // Show skeleton while first fetch is in flight
  const container = document.getElementById("download-progress-container");
  if (container) {
    container.innerHTML = '<div class="download-skeleton"><div class="download-skeleton-bar"></div></div>';
  }

  const fetchAndRender = async () => {
    try {
      const qs = type === "tv" && tvdbId ? `?tvdbId=${tvdbId}` : "";
      const progress = await api(`/api/${type}/${tmdbId}/progress${qs}`);
      const el = document.getElementById("download-progress-container");
      if (!el) {
        clearProgressPolling();
        return;
      }
      el.innerHTML = renderProgressSection(progress, type);
    } catch {
      // Progress is supplementary — fail silently
    }
  };

  fetchAndRender();
  setProgressInterval(setInterval(fetchAndRender, 15_000));
}

// ── Detail View ──────────────────────────────

/**
 * @param {string} type
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function openDetail(type, id) {
  showLoading();
  clearProgressPolling();
  removeRequestBar();

  try {
    const data = await api(`/api/${type}/${id}`);
    setCurrentDetail({ type, id, data });
    setSelectedSeasons(new Set());
    renderDetail(type, data);
  } catch {
    toast("Failed to load details");
  } finally {
    hideLoading();
  }
}

/**
 * @param {any} d
 * @returns {string | null}
 */
export function getTrailerUrl(d) {
  const vids = d.relatedVideos ?? [];
  const trailer = vids.find((v) => v.site === "YouTube" && v.type === "Trailer")
    ?? vids.find((v) => v.site === "YouTube");
  return trailer ? `https://youtube.com/watch?v=${trailer.key}` : null;
}

/**
 * @param {any} d
 * @returns {string | null}
 */
export function getImdbUrl(d) {
  const id = d.externalIds?.imdbId;
  return id ? `https://www.imdb.com/title/${id}/` : null;
}

/**
 * @param {any} d
 * @param {string} type
 * @returns {string | null}
 */
export function getCertification(d, type) {
  if (type === "movie") {
    const us = d.releases?.results?.find((r) => r.iso_3166_1 === "US");
    return us?.release_dates?.find((rd) => rd.certification)?.certification || null;
  }
  const us = d.contentRatings?.results?.find((r) => r.iso_3166_1 === "US");
  return us?.rating || null;
}

/**
 * @param {string} type
 * @param {any} d
 * @returns {void}
 */
export function renderDetail(type, d) {
  const caps = getCaps();
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

  /** @type {string[]} */
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
    <div id="download-progress-container"></div>
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
          is4k: !!/** @type {HTMLInputElement | null} */ (document.getElementById("request-4k-cb"))?.checked,
        });
        hideLoading();
        if (result.success) {
          removeRequestBar();
          if (result.status === 2) {
            toast("Request approved!");
            view.querySelector(".detail-status").innerHTML = "&#9881;&#65039; Approved &mdash; downloading";
          } else {
            toast("Request submitted!");
            view.querySelector(".detail-status").innerHTML = "&#9203; Requested";
          }
        } else {
          toast(formatError(result.error));
        }
      }, caps.has4kMovie);
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
    /** @type {HTMLElement} */ (card).onclick = () => openPerson(Number(/** @type {HTMLElement} */ (card).dataset.personId));
  });

  window.scrollTo(0, 0);

  // Start progress polling if media is downloading
  const progressCaps = getCaps();
  const shouldPoll = (status === 3 || status === 4) &&
    ((type === "movie" && progressCaps.hasProgressRadarr) ||
     (type === "tv" && progressCaps.hasProgressSonarr));
  if (shouldPoll) {
    startProgressPolling(type, d.id, type === "tv" ? d.externalIds?.tvdbId : undefined);
  }

  if (tg) {
    tg.BackButton.show();
    tg.BackButton.onClick(goBack);
  }

  // Load recommendations and similar asynchronously
  loadDetailSlider(`/api/${type}/${d.id}/recommendations`, "detail-recommendations", "Recommendations");
  loadDetailSlider(`/api/${type}/${d.id}/similar`, "detail-similar", "Similar Titles");
}

/**
 * @param {any} watchProviders
 * @returns {Array<{ logoPath: string, name: string }>}
 */
export function extractWatchProviders(watchProviders) {
  if (!watchProviders || !Array.isArray(watchProviders)) return [];
  // Seerr returns array of region-based providers; find US or first available
  for (const region of watchProviders) {
    const flat = region?.flatrate ?? [];
    if (flat.length) return flat;
  }
  // Try flatrate from any structure (fallback for non-array object shapes)
  if (typeof watchProviders === "object" && !Array.isArray(watchProviders)) {
    const wp = /** @type {Record<string, any>} */ (watchProviders);
    const us = wp.US ?? wp.GB ?? Object.values(wp)[0];
    return us?.flatrate ?? [];
  }
  return [];
}

/**
 * @param {any[]} cast
 * @returns {string}
 */
export function renderCastGrid(cast) {
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

/**
 * @param {string} endpoint
 * @param {string} containerId
 * @param {string} title
 * @returns {Promise<void>}
 */
export async function loadDetailSlider(endpoint, containerId, title) {
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

/** @returns {void} */
export function goBack() {
  clearProgressPolling();
  document.getElementById("detail-view").classList.remove("active");
  removeRequestBar();
  setNavigationStack([]);

  const searchInput = /** @type {HTMLInputElement} */ (document.getElementById("search-input"));
  if (searchInput.value.trim().length >= 2) {
    document.getElementById("search-view").classList.add("active");
  } else {
    document.getElementById(`${getCurrentTab()}-view`).classList.add("active");
  }

  setCurrentDetail(null);
  if (tg) tg.BackButton.hide();
}

// ── Season Picker ────────────────────────────

/**
 * @param {any} show
 * @returns {string}
 */
export function renderSeasonPicker(show) {
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

/**
 * @param {any} show
 * @param {any} season
 * @returns {string}
 */
export function getSeasonState(show, season) {
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

/**
 * @param {any} show
 * @param {HTMLElement} view
 * @returns {void}
 */
export function attachSeasonHandlers(show, view) {
  const selectedSeasons = getSelectedSeasons();

  view.querySelectorAll(".season-btn").forEach((btn) => {
    if (/** @type {HTMLElement} */ (btn).dataset.state !== "requestable") return;
    /** @type {HTMLElement} */ (btn).onclick = () => {
      const sn = Number(/** @type {HTMLElement} */ (btn).dataset.season);
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
        selectedSeasons.add(Number(/** @type {HTMLElement} */ (btn).dataset.season));
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

/** @returns {void} */
export function updateClearBtn() {
  const btn = document.getElementById("clear-selection");
  if (btn) /** @type {HTMLElement} */ (btn).style.display = getSelectedSeasons().size > 0 ? "inline-block" : "none";
}

/**
 * @param {any} show
 * @returns {void}
 */
export function updateTvRequestBar(show) {
  const selectedSeasons = getSelectedSeasons();
  const caps = getCaps();

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
      is4k: !!/** @type {HTMLInputElement | null} */ (document.getElementById("request-4k-cb"))?.checked,
    });
    hideLoading();
    if (result.success) {
      toast(result.status === 2 ? `${label} approved!` : `${label} requested!`);
      removeRequestBar();
      selectedSeasons.clear();
      openDetail("tv", show.id);
    } else {
      toast(formatError(result.error));
    }
  }, caps.has4kTv);
}

// ── Person View ─────────────────────────────

/**
 * @param {number} personId
 * @returns {Promise<void>}
 */
export async function openPerson(personId) {
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

/**
 * @param {any} person
 * @returns {void}
 */
export function renderPerson(person) {
  const navigationStack = getNavigationStack();
  const currentDetail = getCurrentDetail();

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

/**
 * @param {string} birthday
 * @param {string | null | undefined} deathday
 * @returns {number}
 */
export function calcAge(birthday, deathday) {
  const end = deathday ? new Date(deathday) : new Date();
  const born = new Date(birthday);
  let age = end.getFullYear() - born.getFullYear();
  const m = end.getMonth() - born.getMonth();
  if (m < 0 || (m === 0 && end.getDate() < born.getDate())) age--;
  return age;
}

/**
 * @param {any} person
 * @returns {Promise<void>}
 */
export async function loadFilmography(person) {
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

/** @returns {void} */
export function goBackFromPerson() {
  const navigationStack = getNavigationStack();
  document.getElementById("person-view").classList.remove("active");

  if (navigationStack.length > 0) {
    const prev = navigationStack.pop();
    openDetail(prev.type, prev.id);
  } else {
    document.getElementById(`${getCurrentTab()}-view`).classList.add("active");
    if (tg) tg.BackButton.hide();
  }
}

// ── Request Bar ──────────────────────────────

/**
 * @param {string} label
 * @param {() => Promise<void>} handler
 * @param {boolean} [show4k=false]
 * @returns {void}
 */
export function showRequestBar(label, handler, show4k = false) {
  removeRequestBar();
  const bar = document.createElement("div");
  bar.className = "request-bar";
  bar.id = "request-bar";
  bar.innerHTML = `${show4k ? '<label class="request-bar-4k"><input type="checkbox" id="request-4k-cb"> 4K</label>' : ""}<button>&#9875; ${escHtml(label)}</button>`;
  bar.querySelector("button").onclick = handler;
  document.body.appendChild(bar);
}

/** @returns {void} */
export function removeRequestBar() {
  document.getElementById("request-bar")?.remove();
}

/**
 * @param {string} error
 * @returns {string}
 */
export function formatError(error) {
  switch (error) {
    case "DUPLICATE": return "Already requested!";
    case "QUOTA": return "Quota exceeded";
    case "BLACKLISTED": return "Title is blacklisted";
    case "NO_PERMISSION": return "No permission";
    case "NO_SEASONS": return "Already requested or available";
    default: return `Request failed: ${error || "unknown error"}`;
  }
}
