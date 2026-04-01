import { posterUrl, year, statusBadge, escHtml } from "./state.js";

// ── Card click handler (set by consumer to avoid circular imports) ──

/** @type {((type: string, id: number) => void) | null} */
let _cardClickHandler = null;

/**
 * @param {(type: string, id: number) => void} fn
 * @returns {void}
 */
export function setCardClickHandler(fn) { _cardClickHandler = fn; }

// ── Grid Rendering ───────────────────────────

/**
 * @param {any[]} items
 * @param {HTMLElement} container
 * @param {boolean} [append=false]
 * @returns {void}
 */
export function renderGrid(items, container, append = false) {
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
    /** @type {HTMLElement} */ (card).onclick = () =>
      _cardClickHandler?.(/** @type {HTMLElement} */ (card).dataset.type, Number(/** @type {HTMLElement} */ (card).dataset.id));
  });
}

/**
 * @param {HTMLElement} container
 * @param {number} [count=9]
 * @returns {void}
 */
export function renderSkeletons(container, count = 9) {
  const grid = document.createElement("div");
  grid.className = "media-grid";
  for (let i = 0; i < count; i++) {
    grid.innerHTML += '<div class="skeleton skeleton-card"></div>';
  }
  container.innerHTML = "";
  container.appendChild(grid);
}

// ── Slider Rendering ─────────────────────────

/**
 * @param {any} item
 * @returns {HTMLDivElement}
 */
export function renderSliderCard(item) {
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

  card.onclick = () => _cardClickHandler?.(item.mediaType, item.id);
  return card;
}

/**
 * @returns {string}
 */
export function renderSliderSkeletons() {
  let html = "";
  for (let i = 0; i < 6; i++) {
    html += '<div class="slider-card"><div class="skeleton" style="width:120px;height:180px;border-radius:var(--radius)"></div></div>';
  }
  return html;
}

// ── Load More Helper ─────────────────────────

/**
 * @param {HTMLElement} container
 * @param {() => Promise<void>} handler
 * @returns {void}
 */
export function addLoadMore(container, handler) {
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

/**
 * @param {HTMLElement} container
 * @returns {void}
 */
export function removeLoadMore(container) {
  container.querySelector(".load-more")?.remove();
}
