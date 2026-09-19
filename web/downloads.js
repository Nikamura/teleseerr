import { api, apiPost, escHtml, getUserState } from "./state.js";

/** @param {string} type @param {number} id */
export function mountDownloads(type, id) {
  const host = document.getElementById("download-management");
  if (!host || !getUserState()?.manageDownloads) return;
  host.innerHTML = '<div class="detail-section-title">Manage downloads</div><p>Help recover shared downloads, whoever requested them.</p><button class="quick-btn secondary">Check downloads</button><div class="download-results" aria-live="polite"></div>';
  const button = host.querySelector("button");
  const results = host.querySelector(".download-results");
  button.onclick = async () => {
    button.disabled = true;
    results.textContent = "Checking downloads…";
    try {
      const data = await api(`/api/${type}/${id}/downloads`);
      if (data.error) throw new Error(data.error);
      if (!data.items.length) {
        results.textContent = data.configured ? "No active transfers found. This does not mean a release is available or a search is running." : "Download service is not configured.";
        return;
      }
      results.innerHTML = data.items.map((item, index) => `<div class="release-card"><strong>${escHtml(item.title)}</strong><p>${escHtml(item.instance)} · ${escHtml(item.status)} · ${item.percent}%${item.eta ? ` · ETA ${escHtml(item.eta)}` : ""}</p>${item.episodes.length ? `<p>${item.episodes.length > 1 ? "Shared transfer: " : ""}${item.episodes.map(ep => `S${ep.seasonNumber}E${ep.episodeNumber}`).join(", ")}</p>` : ""}<button class="quick-btn secondary" data-target="${index}" ${item.canReplace ? "" : "disabled"}>Find alternatives</button><div class="release-options"></div></div>`).join("");
      results.querySelectorAll("[data-target]").forEach(element => {
        const searchButton = /** @type {HTMLButtonElement} */ (element);
        searchButton.onclick = () => findAlternatives(data.items[Number(searchButton.dataset.target)], searchButton);
      });
    } catch (error) { results.textContent = error.message || "Download status temporarily unavailable"; }
    finally { button.disabled = false; }
  };
}

/** @param {any} target @param {HTMLButtonElement} button */
async function findAlternatives(target, button) {
  const results = button.parentElement.querySelector(".release-options");
  button.disabled = true;
  results.textContent = "Searching indexers… This can take up to 90 seconds.";
  try {
    const data = await apiPost("/api/downloads/search", { instance: target.instance, queueId: target.queueId });
    if (data.error) throw new Error(data.error);
    if (!data.releases.length) { results.textContent = "No alternatives found."; return; }
    const sorted = [...data.releases].sort((a, b) => Number(!!a.problems.length) - Number(!!b.problems.length));
    results.innerHTML = '<p>Seed counts are reported by indexers and do not guarantee speed. Choices expire after two minutes.</p>' + sorted.map(r => `<div class="release-card"><strong>${escHtml(r.title)}</strong><p>${escHtml(r.quality)} · ${(r.size / 1024 ** 3).toFixed(1)} GiB · ${r.seeders ?? "Unknown"} seeders · ${escHtml(r.languages.join(", "))}</p>${r.problems.length ? `<p class="release-warning">${r.problems.map(escHtml).join(" · ")}</p>` : ""}<button class="quick-btn secondary" data-release="${r.index}" ${r.problems.length ? "disabled" : ""}>Switch to this release</button></div>`).join("");
    results.querySelectorAll("[data-release]").forEach(element => {
      const switchButton = /** @type {HTMLButtonElement} */ (element);
      switchButton.onclick = async () => {
        if (!confirm(`Replace this download for everyone? Current progress may be lost.${data.pack ? " This is a shared season transfer: all its episodes are affected." : ""}`)) return;
        results.querySelectorAll("button").forEach(b => { b.disabled = true; });
        button.disabled = true;
        try {
          const result = await apiPost("/api/downloads/switch", { token: data.token, index: Number(switchButton.dataset.release), confirmed: true });
          if (result.error) throw new Error(result.error);
          results.textContent = result.warning || "New release accepted. Check downloads again shortly to see its progress.";
        } catch (error) { results.textContent = error.message || "Could not confirm replacement. Check downloads before retrying."; }
        finally { button.disabled = false; }
      };
    });
  } catch (error) { results.textContent = error.message || "Release search failed"; }
  finally { button.disabled = false; }
}
