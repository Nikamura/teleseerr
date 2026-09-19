import { api, apiPost, escHtml } from "./state.js";

const episodeLabels = {
  available: "Available", missing: "Missing", unaired: "Not aired yet", unknown: "Air date unknown",
  downloading: "Downloading", queued: "Queued", paused: "Paused", importing: "Preparing for playback",
  failed: "Download failed", attention: "Needs attention",
};

/** @param {any} data @param {number} tmdbId @returns {string} */
function renderEpisodes(data, tmdbId) {
  if (!data.libraries?.some(l => l.inLibrary)) return '<p>No episode records found in the connected library.</p>';
  return data.libraries.filter(l => l.inLibrary).map(library => {
    const episodes = library.episodes;
    if (!episodes.length) return '<p>Episode information is not available yet.</p>';
    const available = episodes.filter(e => e.state === "available").length;
    const missing = episodes.filter(e => e.state === "missing").length;
    const seasons = [...new Set(episodes.map(e => e.season))];
    return `<p class="episode-overview"><strong>${available} of ${episodes.length} episodes available</strong>${missing ? ` · ${missing} missing` : ""}${data.libraries.length > 1 ? ` · ${escHtml(library.instance)}` : ""}</p>` + seasons.map(season => {
      const group = episodes.filter(e => e.season === season);
      const ready = group.filter(e => e.state === "available").length;
      return `<details class="episode-season"><summary>${season === 0 ? "Specials" : `Season ${season}`} <span>${ready}/${group.length} available</span></summary><div class="episode-list">` + group.map(ep => {
        const label = episodeLabels[ep.state] ?? "Status unknown";
        const date = ep.airDate ? new Date(ep.airDate).toLocaleDateString(undefined, {year:"numeric",month:"short",day:"numeric"}) : "";
        return `<div class="episode-row"><div class="episode-heading"><strong>S${String(ep.season).padStart(2,"0")}E${String(ep.episode).padStart(2,"0")} · ${escHtml(ep.title)}</strong><span class="episode-state episode-state-${ep.state}">${label}${ep.percent != null && ep.state !== "available" ? ` · ${ep.percent}%` : ""}</span></div>${date ? `<p>${ep.state === "unaired" ? "Airs" : "Air date"}: ${escHtml(date)}</p>` : ""}${!ep.monitored && ep.state === "missing" ? '<p>Not monitored for downloads.</p>' : ""}${ep.canSearch ? `<button class="quick-btn secondary" data-episode="${ep.id}" data-instance="${escHtml(library.instance)}" data-tmdb="${tmdbId}" ${ep.queueId != null ? `data-queue="${ep.queueId}"` : ""}>${ep.queueId != null ? "Find alternatives" : "Find releases"}</button>` : ""}<div class="release-options" aria-live="polite"></div></div>`;
      }).join("") + '</div></details>';
    }).join("");
  }).join("");
}

/** @param {string} type @param {number} id */
export function mountDownloads(type, id) {
  const host = document.getElementById("download-management");
  if (!host) return;
  host.innerHTML = `<div class="episode-section-header"><div class="detail-section-title">${type === "tv" ? "Episodes" : "Downloads"}</div><button class="quick-btn secondary">Refresh</button></div><div class="download-results" aria-live="polite"></div>`;
  const button = host.querySelector("button");
  const results = host.querySelector(".download-results");
  const refresh = async () => {
    button.disabled = true;
    results.textContent = type === "tv" ? "Loading episodes…" : "Checking downloads…";
    try {
      const data = await api(`/api/${type}/${id}/downloads`);
      if (data.error) throw new Error(data.error);
      if (!host.isConnected) return;
      if (!data.configured) { results.textContent = "Library status is not configured."; return; }
      if (type === "tv") {
        results.innerHTML = renderEpisodes(data, id);
        results.querySelectorAll("[data-episode]").forEach(element => {
          const searchButton = /** @type {HTMLButtonElement} */ (element);
          const d = searchButton.dataset;
          searchButton.onclick = () => findAlternatives({ instance:d.instance, ...(d.queue ? {queueId:Number(d.queue)} : {tmdbId:id,episodeId:Number(d.episode)}) },searchButton);
        });
      } else {
        results.innerHTML = data.items.length ? data.items.map((item, index) => `<div class="release-card"><strong>${escHtml(item.title)}</strong><p>${escHtml(item.instance)} · ${escHtml(item.status)} · ${item.percent}%${item.eta ? ` · ETA ${escHtml(item.eta)}` : ""}</p>${item.canReplace ? `<button class="quick-btn secondary" data-target="${index}">Find alternatives</button>` : ""}<div class="release-options"></div></div>`).join("") : '<p>No active downloads.</p>';
        results.querySelectorAll("[data-target]").forEach(element => {
          const searchButton = /** @type {HTMLButtonElement} */ (element);
          searchButton.onclick = () => findAlternatives(data.items[Number(searchButton.dataset.target)], searchButton);
        });
      }
    } catch (error) { results.textContent = error.message || "Library status temporarily unavailable. Try Refresh."; }
    finally { button.disabled = false; }
  };
  button.onclick = refresh;
  void refresh();
}

/** @param {any} target @param {HTMLButtonElement} button */
async function findAlternatives(target, button) {
  const results = button.parentElement.querySelector(".release-options");
  button.disabled = true;
  results.textContent = "Searching indexers… This can take up to 90 seconds.";
  try {
    const data = await apiPost("/api/downloads/search", { instance: target.instance, queueId: target.queueId, tmdbId: target.tmdbId, episodeId: target.episodeId });
    if (data.error) throw new Error(data.error);
    if (!data.releases.length) { results.textContent = "No alternatives found."; return; }
    const sorted = [...data.releases].sort((a, b) => Number(!!a.problems.length) - Number(!!b.problems.length));
    results.innerHTML = '<p>Seed counts are reported by indexers and do not guarantee speed. Choices expire after two minutes.</p>' + sorted.map(r => `<div class="release-card"><strong>${escHtml(r.title)}</strong><p>${escHtml(r.quality)} · ${(r.size / 1024 ** 3).toFixed(1)} GiB · ${r.seeders ?? "Unknown"} seeders · ${escHtml(r.languages.join(", "))}</p>${r.problems.length ? `<p class="release-warning">${r.problems.map(escHtml).join(" · ")}</p>` : ""}<button class="quick-btn secondary" data-release="${r.index}" ${r.problems.length ? "disabled" : ""}>${data.action === "download" ? "Download this release" : "Switch to this release"}</button></div>`).join("");
    results.querySelectorAll("[data-release]").forEach(element => {
      const switchButton = /** @type {HTMLButtonElement} */ (element);
      switchButton.onclick = async () => {
        if (!confirm(data.action === "download" ? "Download this release for the missing episode? It will be available to everyone when ready." : `Replace this download for everyone? Current progress may be lost.${data.pack ? " This is a shared season transfer: all its episodes are affected." : ""}`)) return;
        results.querySelectorAll("button").forEach(b => { b.disabled = true; });
        button.disabled = true;
        try {
          const result = await apiPost("/api/downloads/switch", { token: data.token, index: Number(switchButton.dataset.release), confirmed: true });
          if (result.error) throw new Error(result.error);
          results.textContent = result.warning || "New release accepted. Refresh shortly to see its progress.";
        } catch (error) { results.textContent = error.message || "Could not confirm replacement. Check downloads before retrying."; }
        finally { button.disabled = false; }
      };
    });
  } catch (error) { results.textContent = error.message || "Release search failed"; }
  finally { button.disabled = false; }
}
