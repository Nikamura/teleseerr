import { openSupport } from "./support.js";
import { api, apiPost, escHtml } from "./state.js";
import { confirmAction, haptic } from "./native.js";

const episodeLabels = {
  available: "Available", missing: "Missing", unaired: "Not aired yet", unknown: "Air date unknown",
  downloading: "Downloading", queued: "Queued", paused: "Paused", importing: "Preparing for playback",
  failed: "Download failed", attention: "Needs attention",
};

/** @param {any} show @param {number} season @param {boolean} [is4k] @returns {{label:string, active:boolean}} */
function seasonRequestStatus(show, season, is4k = false) {
  const requests = (show?.mediaInfo?.requests ?? []).filter(r => !!r.is4k === is4k && r.seasons?.some(s => s.seasonNumber === season));
  if (requests.some(r => r.status === 2)) return { label: "Requested · approved", active: true };
  if (requests.some(r => r.status === 1)) return { label: "Awaiting approval", active: true };
  if (requests.some(r => r.status === 4)) return { label: "Request failed", active: false };
  if (requests.some(r => r.status === 3)) return { label: "Request declined", active: false };
  return { label: "No active season request", active: false };
}

/** @param {any} data @param {number} tmdbId @param {any} [options] @returns {string} */
function renderEpisodes(data, tmdbId, options = {}) {
  const libraries = data.libraries?.filter(l => l.inLibrary) ?? [];
  if (!libraries.length) libraries.push({ instance: "", episodes: [], searches: [] });
  return libraries.map(library => {
    const episodes = library.episodes;
    const available = episodes.filter(e => e.state === "available").length;
    const missing = episodes.filter(e => e.state === "missing").length;
    const seasons = [...new Set([...(options.show?.seasons ?? []).filter(s => s.seasonNumber !== 0).map(s => s.seasonNumber), ...episodes.map(e => e.season)])].sort((a,b) => a-b);
    return (episodes.length ? `<p class="episode-overview"><strong>${available} of ${episodes.length} episodes available</strong>${missing ? ` · ${missing} missing` : ""}${data.libraries.length > 1 ? ` · ${escHtml(library.instance)}` : ""}</p>` : "") + seasons.map(season => {
      const group = episodes.filter(e => e.season === season);
      const ready = group.filter(e => e.state === "available").length;
      const missing = group.filter(e => e.state === "missing");
      const attention = group.filter(e => ["failed", "attention", "paused"].includes(e.state)).length;
      const transferring = group.filter(e => ["downloading", "queued", "importing"].includes(e.state)).length;
      const upcoming = group.filter(e => e.state === "unaired").length;
      const unknown = group.filter(e => e.state === "unknown").length;
      const complete = group.length > 0 && ready === group.length;
      const request = seasonRequestStatus(options.show, season, library.instance?.includes("4k"));
      const metadata = options.show?.seasons?.find(s => s.seasonNumber === season);
      const selectable = !library.instance?.includes("4k") && !complete && season !== 0 && metadata && options.seasonState?.(options.show, metadata) === "requestable";
      const requestAction = selectable ? `<button class="season-btn" data-state="requestable" data-season="${season}" aria-pressed="false">Request season ${season}</button>` : "";
      const episodeNote = !group.length ? '<p class="season-empty">Episode details will appear here when the show is in the connected download library. Use the season selection here to request missing seasons.</p>' : "";
      const badges = (group.length ? `<span class="season-status season-status-${complete ? "complete" : "available"}">${complete ? "✓ " : ""}${ready}/${group.length} ${complete ? "complete" : "available"}</span>` : metadata?.episodeCount ? `<span class="season-status season-status-available">${metadata.episodeCount} episodes</span>` : "") +
        (missing.length ? `<span class="season-status season-status-missing">${missing.length} missing</span>` : "") +
        (attention ? `<span class="season-status season-status-missing">${attention} need attention</span>` : "") +
        (transferring ? `<span class="season-status season-status-downloading">${transferring} downloading / queued</span>` : "") +
        (upcoming ? `<span class="season-status season-status-available">${upcoming} not aired</span>` : "") +
        (unknown ? `<span class="season-status season-status-available">${unknown} air date unknown</span>` : "");
      const unmonitored = missing.filter(e => !e.monitored).length;
      const search = library.searches?.find(s => s.season === season);
      const searching = search && ["queued", "started"].includes(search.status);
      const recovery = `<div class="season-recovery">${!data.canManage && missing.length ? '<p class="episode-intent">Episode downloads need download-management access from your admin.</p>' : ""}${missing.length ? `<p>${missing.length} missing${unmonitored ? ` · ${unmonitored} not monitored` : ""}</p>` : ""}${searching ? '<p role="status">Searching for requested episodes…</p>' : search?.status === "failed" ? '<p>Search failed. Refresh or try again.</p>' : search?.status === "completed" && missing.length ? '<p>Search finished. Some episodes still need a suitable release.</p>' : ""}${data.canManage && missing.length && !searching ? `<button class="quick-btn secondary" data-recover-season="${season}" data-count="${missing.length}" data-instance="${escHtml(library.instance)}">Download missing episodes</button>` : ""}<p class="recovery-result" role="status"></p></div>`;
      return `<details class="episode-season" data-season="${season}" data-library="${escHtml(library.instance)}"><summary>${season === 0 ? "Specials" : `Season ${season}`} <span class="season-statuses"><span class="season-status ${request.active ? "season-status-downloading" : "season-status-available"}">${request.label}</span>${badges}</span></summary><div class="season-actions">${requestAction}${episodeNote}${complete && data.canManage && group.length > 1 ? `<button class="quick-btn secondary" data-replace-season="${season}" data-instance="${escHtml(library.instance)}">Replace season files</button><div class="release-options" aria-live="polite"></div>` : ""}</div>${recovery}<div class="episode-list">` + group.map(ep => {
        const label = episodeLabels[ep.state] ?? "Status unknown";
        const intent = ep.state === "missing" ? (request.active ? request.label : ep.monitored ? "Monitored for downloads" : "Not monitored for downloads") : "";
        const date = ep.airDate ? new Date(ep.airDate).toLocaleDateString(undefined, {year:"numeric",month:"short",day:"numeric"}) : "";
        return `<div class="episode-row"><div class="episode-heading"><strong>S${String(ep.season).padStart(2,"0")}E${String(ep.episode).padStart(2,"0")} · ${escHtml(ep.title)}</strong><span class="episode-state episode-state-${ep.state}">${label}${ep.percent != null && ep.state !== "available" ? ` · ${ep.percent}%` : ""}</span></div>${date ? `<p>${ep.state === "unaired" ? "Airs" : "Air date"}: ${escHtml(date)}</p>` : ""}${intent ? `<p class="episode-intent">${intent}</p>` : ""}${data.canManage && ep.state === "missing" && !searching ? `<button class="quick-btn secondary" data-recover-season="${season}" data-recover-episode="${ep.id}" data-episode-label="S${String(season).padStart(2,"0")}E${String(ep.episode).padStart(2,"0")}" data-count="1" data-instance="${escHtml(library.instance)}">Download episode</button><p class="recovery-result" role="status"></p>` : ""}${ep.canReplaceFile ? `<button class="quick-btn secondary" data-episode="${ep.id}" data-instance="${escHtml(library.instance)}" data-replace-file="true">Replace episode</button>` : ""}${ep.canSearch ? `<button class="quick-btn secondary" data-episode="${ep.id}" data-instance="${escHtml(library.instance)}" data-tmdb="${tmdbId}" ${ep.queueId != null ? `data-queue="${ep.queueId}"` : ""}>${ep.queueId != null ? "Find alternatives" : "Find releases"}</button>` : ""}<button class="quick-btn secondary" data-help-episode="${ep.id}" data-instance="${escHtml(library.instance)}">Having trouble?</button><div class="release-options" aria-live="polite"></div></div>`;
      }).join("") + '</div></details>';
    }).join("");
  }).join("");
}

/** @param {string} type @param {number} id @param {any} [options] */
export function mountDownloads(type, id, options = {}) {
  const host = document.getElementById("download-management");
  if (!host) return;
  host.innerHTML = `<div class="episode-section-header"><div class="detail-section-title">${type === "tv" ? "Seasons & episodes" : "Downloads"}</div><button class="quick-btn secondary">Refresh</button></div><div class="download-results" aria-live="polite"></div>`;
  if (type === "tv" && options.show) {
    host.querySelector(".download-results").innerHTML = (options.renderControls?.(options.show) ?? "") + renderEpisodes({ libraries: [], canManage: false }, id, options);
    options.onRender?.(host);
  }
  const button = /** @type {HTMLButtonElement} */ (host.querySelector(".episode-section-header button"));
  const results = host.querySelector(".download-results");
  let timer;
  const refresh = async () => {
    clearTimeout(timer);
    if (!host.isConnected || !host.closest(".view")?.classList.contains("active")) return;
    const expanded = [...results.querySelectorAll("details[open]")].map(el => `${el.getAttribute("data-library")}:${el.getAttribute("data-season")}`);
    button.disabled = true;
    if (type !== "tv") results.textContent = "Checking downloads…";
    try {
      const [data, show] = await Promise.all([
        api(`/api/${type}/${id}/downloads`),
        type === "tv" && options.show ? api(`/api/tv/${id}`).catch(() => null) : Promise.resolve(null),
      ]);
      if (show && !show.error && show.id === id) Object.assign(options.show, show);
      if (data.error) throw new Error(data.error);
      if (!host.isConnected) return;
      if (!data.configured && type !== "tv") { results.textContent = "Library status is not configured."; return; }
      if (type === "tv") {
        results.innerHTML = (options.renderControls?.(options.show) ?? "") + renderEpisodes(data, id, options);
        options.onRender?.(host);
        results.querySelectorAll("[data-help-episode]").forEach(el => el.addEventListener("click", () => { const d = /** @type {HTMLElement} */ (el).dataset; void openSupport({type:"tv",tmdbId:id,episodeId:Number(d.helpEpisode),instance:d.instance}); }));
        results.querySelectorAll("details").forEach(el => {
          if (expanded.includes(`${el.getAttribute("data-library")}:${el.getAttribute("data-season")}`)) el.setAttribute("open", "");
        });
        results.querySelectorAll("[data-recover-season]").forEach(element => {
          const action = /** @type {HTMLButtonElement} */ (element);
          action.onclick = async () => {
            const season = Number(action.dataset.recoverSeason);
            const episodeId = action.dataset.recoverEpisode ? Number(action.dataset.recoverEpisode) : undefined;
            if (!(await confirmAction(episodeId ? `Download ${action.dataset.episodeLabel}? This restores monitoring and searches for this episode only. Normal automatic cleanup still applies.` : `Resume downloads for ${action.dataset.count} missing aired episodes in ${season === 0 ? "Specials" : `Season ${season}`}? This restores monitoring and starts a search. Downloads are shared with everyone. Normal automatic cleanup still applies.`, { ok: episodeId ? "Download" : "Resume downloads" }))) return;
            clearTimeout(timer);
            action.disabled = true;
            const output = action.parentElement.querySelector(".recovery-result");
            output.textContent = "Restoring monitoring and starting search…";
            try {
              const response = await apiPost("/api/downloads/recover-season", { instance: action.dataset.instance, tmdbId: id, season, ...(episodeId === undefined ? {} : { episodeId }), confirmed: true });
              if (response.error) throw new Error(response.error);
              output.textContent = response.message;
              timer = setTimeout(() => {
                if (!results.querySelector(".release-options:not(:empty)")) void refresh();
              }, 8000);
            } catch (error) {
              output.textContent = error.message;
              action.disabled = false;
            }
          };
        });
        if (data.libraries?.some(l => l.searches?.some(s => ["queued", "started"].includes(s.status)) || l.episodes.some(e => ["downloading", "queued", "paused", "importing", "attention", "failed"].includes(e.state)))) timer = setTimeout(() => {
                if (!results.querySelector(".release-options:not(:empty)")) void refresh();
              }, 8000);
        results.querySelectorAll("[data-replace-season]").forEach(el => el.addEventListener("click", () => { const b=/** @type {HTMLButtonElement} */(el); const library=data.libraries.find(l=>l.instance===b.dataset.instance); void findAlternatives({instance:b.dataset.instance,tmdbId:id,replaceExisting:true,episodeIds:library.episodes.filter(e=>e.season===Number(b.dataset.replaceSeason)).map(e=>e.id)},b); }));
        results.querySelectorAll("[data-episode]").forEach(element => {
          const searchButton = /** @type {HTMLButtonElement} */ (element);
          const d = searchButton.dataset;
          searchButton.onclick = () => findAlternatives({ instance:d.instance, ...(d.queue ? {queueId:Number(d.queue)} : {tmdbId:id,episodeId:Number(d.episode),replaceExisting:d.replaceFile === "true"}) },searchButton);
        });
      } else {
        results.innerHTML = data.items.length ? data.items.map((item, index) => `<div class="release-card"><strong>${escHtml(item.title)}</strong><p>${escHtml(item.instance)} · ${escHtml(item.status)} · ${item.percent}%${item.eta ? ` · ETA ${escHtml(item.eta)}` : ""}</p>${item.canReplace ? `<button class="quick-btn secondary" data-target="${index}">Find alternatives</button>` : ""}<div class="release-options"></div></div>`).join("") : '<p>No active downloads.</p>';
        results.innerHTML += data.libraries.filter(l=>l.canReplaceMovie).map(l=>`<div class="release-card"><button class="quick-btn secondary" data-replace-movie="${escHtml(l.instance)}">Replace movie file</button><div class="release-options" aria-live="polite"></div></div>`).join("");
        results.querySelectorAll("[data-replace-movie]").forEach(el=>el.addEventListener("click",()=>findAlternatives({instance:/** @type {HTMLElement} */(el).dataset.replaceMovie,tmdbId:id,replaceExisting:true},/** @type {HTMLButtonElement} */(el))));
        results.querySelectorAll("[data-target]").forEach(element => {
          const searchButton = /** @type {HTMLButtonElement} */ (element);
          searchButton.onclick = () => findAlternatives(data.items[Number(searchButton.dataset.target)], searchButton);
        });
      }
    } catch (error) {
      if (type === "tv" && options.show) {
        const note = document.createElement("p");
        note.className = "library-status-error";
        note.textContent = "Library status unavailable. Request controls are still available; try Refresh for episode status.";
        results.querySelector(".library-status-error")?.remove();
        results.prepend(note);
      } else results.textContent = error.message || "Library status temporarily unavailable. Try Refresh.";
    }
    finally { button.disabled = false; }
  };
  button.onclick = refresh;
  void refresh();
}

/** @param {any} target @param {HTMLButtonElement} button */
export async function findAlternatives(target, button) {
  const results = button.parentElement.querySelector(".release-options");
  button.disabled = true;
  results.textContent = "Searching indexers… This can take up to 90 seconds.";
  try {
    const data = await apiPost("/api/downloads/search", { instance: target.instance, queueId: target.queueId, tmdbId: target.tmdbId, episodeId: target.episodeId, episodeIds: target.episodeIds, audio: target.audio, replaceExisting: target.replaceExisting === true });
    if (data.error) throw new Error(data.error);
    if (!data.releases.length) { results.textContent = "No alternatives found."; return; }
    const replacementNote = data.action === "replace-file" ? '<p>Choose a different release. The current file stays while the replacement downloads. The library service handles import. Same-quality replacement is allowed when the quality and format score are verified; other rejection rules still apply.</p>' : "";
    const sorted = [...data.releases].sort((a, b) => Number(!!a.problems.length) - Number(!!b.problems.length));
    results.innerHTML = replacementNote + '<p>Release language labels are advertised, not verified audio tracks. Check the imported file after downloading.</p><p>Seed counts are reported by indexers and do not guarantee speed. Choices expire after two minutes.</p>' + sorted.map(r => `<div class="release-card"><strong>${escHtml(r.title)}</strong><p>${escHtml(r.quality)} · ${(r.size / 1024 ** 3).toFixed(1)} GiB · ${r.seeders ?? "Unknown"} seeders · ${escHtml(r.languages.join(", "))}</p>${r.problems.length ? `<p class="release-warning">${r.problems.map(escHtml).join(" · ")}</p>` : ""}<button class="quick-btn secondary" data-release="${r.index}" ${r.problems.length ? "disabled" : ""}>${data.action === "download" ? "Download this release" : data.action === "replace-file" ? "Replace with this release" : "Switch to this release"}</button></div>`).join("");
    results.querySelectorAll("[data-release]").forEach(element => {
      const switchButton = /** @type {HTMLButtonElement} */ (element);
      switchButton.onclick = async () => {
        if (!(await confirmAction(data.action === "replace-file" ? `Download a replacement for ${data.pack ? "every episode in this season" : "this file"}? Current files stay while it downloads. The library service may replace them during import. This affects everyone using the shared library.` : data.action === "download" ? "Download this release for the missing episode? It will be available to everyone when ready." : `Replace this download for everyone? Current progress may be lost.${data.pack ? " This is a shared season transfer: all its episodes are affected." : ""}`, data.action === "download" ? { ok: "Download" } : { ok: "Replace", destructive: data.action !== "replace-file" }))) return;
        results.querySelectorAll("button").forEach(b => { b.disabled = true; });
        button.disabled = true;
        try {
          const result = await apiPost("/api/downloads/switch", { token: data.token, index: Number(switchButton.dataset.release), confirmed: true });
          if (result.error) throw new Error(result.error);
          haptic(result.warning ? "warning" : "success");
          results.textContent = result.warning || result.message || "New release accepted. Refresh shortly to see its progress.";
        } catch (error) { haptic("error"); results.textContent = error.message || "Could not confirm replacement. Check downloads before retrying."; }
        finally { button.disabled = false; }
      };
    });
  } catch (error) { results.textContent = error.message || "Release search failed"; }
  finally { button.disabled = false; }
}
