import { findAlternatives } from "./downloads.js";
import { api, apiPost, escHtml, toast, getUserState } from "./state.js";

const reasons = {
  download: "Not downloading",
  playback: "Won’t play",
  "wrong-episode": "Wrong episode",
  audio: "Audio or language",
  subtitles: "Subtitles",
  other: "Something else",
};
/** @param {string} title */
function sheet(title) {
  document.getElementById("support-dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "support-dialog";
  dialog.className = "support-dialog";
  dialog.innerHTML = `<header><div><p class="section-kicker">Here to help</p><h2>${escHtml(title)}</h2></div><button class="quick-btn secondary" aria-label="Close">✕</button></header><div class="support-content"></div>`;
  dialog.querySelector("header button").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, content: /** @type {HTMLElement} */ (dialog.querySelector(".support-content")) };
}
/** @param {any} target */
export async function openSupport(target) {
  const { dialog, content } = sheet(target.episodeId ? "Episode help" : "Having trouble?");
  content.innerHTML = '<p role="status">Checking the library and downloads…</p>';
  try {
    const query = new URLSearchParams();
    if (target.episodeId) query.set("episodeId", target.episodeId);
    if (target.instance) query.set("instance", target.instance);
    const data = await api(`/api/${target.type}/${target.tmdbId}/support?${query}`);
    if (!dialog.isConnected) return;
    content.innerHTML = `<p class="support-muted">Checked ${escHtml(new Date(data.checkedAt).toLocaleTimeString())}. Playback on your device is not tested.</p>${data.requests?.length ? `<p>Requests: ${[...new Set(data.requests.map((r) => ({ 1: "Awaiting approval", 2: "Approved", 4: "Failed to submit" })[r.status]))].map(escHtml).join(" · ")}. See Requests to change your pending requests.</p>` : ""}<div class="support-diagnosis">${!data.configured ? "<p>Download-library diagnostics are not configured. You can still send a report.</p>" : ""}${data.libraries
      .map(
        (l) =>
          `<section class="support-library"><h3>${escHtml(l.instance)}</h3>${
            !l.reachable
              ? '<p class="release-warning">Service unavailable. Re-downloading will not fix an outage.</p>'
              : !l.inLibrary
                ? "<p>This title is not in this download library. Check your request status; it may be awaiting approval.</p>"
                : `<p>${l.monitored ? "Monitored for downloads" : "Not monitored for new downloads"}</p>${data.canManage ? `<button class="quick-btn secondary" data-action="refresh-library" data-instance="${escHtml(l.instance)}">Refresh library status</button>` : ""}${l.episodes
                    .filter((e) => e.state !== "available")
                    .slice(0, 8)
                    .map(
                      (e) =>
                        `<p>S${e.season}E${e.episode}: ${escHtml(e.state)}${!e.monitored ? " · not monitored" : ""}</p>`,
                    )
                    .join("")}${
                    l.files.length
                      ? `<details><summary>Verified file tracks · ${l.files.length} file${l.files.length === 1 ? "" : "s"}</summary>${l.files
                          .slice(0, 24)
                          .map(
                            (f) =>
                              `<p>Audio: ${escHtml(f.audio)} · ${escHtml(f.audioCodec)}${f.channels ? ` ${f.channels}ch` : ""}<br>Subtitles: ${escHtml(f.subtitles)}<br>Video: ${escHtml(f.videoCodec)} · ${escHtml(f.resolution)}</p>`,
                          )
                          .join("")}</details>`
                      : "<p>No imported file is available yet.</p>"
                  }${l.transfers.map((t) => `<div class="support-transfer"><strong>${escHtml(t.title)}</strong><p>${escHtml(t.state)}${t.stalled ? " · stalled" : ""}${t.speed !== null ? ` · ${(t.speed / 1024 / 1024).toFixed(1)} MB/s · ${t.seeds} seeds / ${t.peers} peers` : ""}</p>${t.lastActivity ? `<p>Last activity: ${escHtml(new Date(t.lastActivity).toLocaleString())}</p>` : ""}${t.problems.map((p) => `<p class="release-warning">${escHtml(p)}</p>`).join("")}${data.canManage && t.canPrioritize ? `<button class="quick-btn secondary" data-action="priority" data-queue="${t.queueId}" data-instance="${escHtml(l.instance)}">Watch sooner</button>` : ""}${data.canManage && t.canRetryImport ? `<button class="quick-btn secondary" data-action="retry-import" data-queue="${t.queueId}" data-instance="${escHtml(l.instance)}">Retry import</button>` : ""}</div>`).join("")}`
          }</section>`,
      )
      .join(
        "",
      )}</div>${data.cleanupAvailable ? data.cleanup.map((c) => `<p class="release-warning">${c.season !== null ? `Season ${c.season}` : "This title or a season"} is eligible for ${escHtml(c.action.toLowerCase())}${c.eligibleAt ? ` from ${escHtml(new Date(c.eligibleAt).toLocaleDateString())}` : " at the next cleanup run"}. Timing depends on the cleanup service.</p>`).join("") || '<p class="support-muted">No matching cleanup collection found.</p>' : '<p class="support-muted">Cleanup schedule unavailable.</p>'}${
      data.canManage
        ? `<div class="support-releases">${data.libraries
            .filter((l) => l.reachable && l.inLibrary)
            .map((l) => {
              const t = l.transfers.find((t) => t.remaining > 0);
              const canReplace =
                l.files.length > 0 && (target.type === "movie" || target.episodeId);
              return t || canReplace
                ? `<button class="quick-btn secondary" data-help-release="${escHtml(l.instance)}" ${t ? `data-help-queue="${t.queueId}"` : ""}>${t ? "Find alternatives" : "Replace imported file"}</button><button class="quick-btn secondary" data-help-release="${escHtml(l.instance)}" data-audio="eng" ${t ? `data-help-queue="${t.queueId}"` : ""}>Find English releases</button><div class="release-options" aria-live="polite"></div>`
                : "";
            })
            .join("")}</div>`
        : ""
    }${data.playback ? `<details class="support-library"><summary>Your active playback</summary><p>${escHtml(data.playback.message)}</p>${data.playback.sessions.map((s) => `<p>${escHtml(s.device)} · ${escHtml(s.state)}<br>Video: ${escHtml(s.video)} · Audio: ${escHtml(s.audio)} · Subtitles: ${escHtml(s.subtitles)}</p>${s.selectedTracks.map((t) => `<p>${escHtml(t.kind)}: ${escHtml(t.language)} · ${escHtml(t.codec)}</p>`).join("")}`).join("")}</details>` : ""}<form id="problem-form"><label>What’s wrong?<select name="category">${Object.entries(
      reasons,
    )
      .map(([key, label]) => `<option value="${key}">${label}</option>`)
      .join(
        "",
      )}</select></label><p id="support-guidance"></p><label>Device or app<input name="device" maxlength="100" placeholder="e.g. Samsung TV, Plex on iPhone"></label><label>What happened?<textarea name="notes" maxlength="2000" rows="3" placeholder="What did you try? Any error message?"></textarea></label><button class="quick-btn" type="submit">Send report</button><p role="status" id="report-result"></p></form><details class="support-preferences"><summary>Audio & subtitle preferences</summary><p>Used as guidance when choosing a replacement. Release labels do not guarantee the tracks in a file.</p><label>Audio<select id="audio-pref">${languageOptions(data.preferences.audio)}</select></label><label>Subtitles<select id="subtitle-pref">${languageOptions(data.preferences.subtitles)}</select></label><button class="quick-btn secondary" id="save-preferences">Save preferences</button></details>`;
    content.querySelectorAll("[data-help-release]").forEach((el) =>
      el.addEventListener("click", () => {
        const b = /** @type {HTMLButtonElement} */ (el);
        void findAlternatives(
          {
            instance: b.dataset.helpRelease,
            tmdbId: target.tmdbId,
            episodeId: target.episodeId,
            ...(b.dataset.helpQueue
              ? { queueId: Number(b.dataset.helpQueue) }
              : { replaceExisting: true }),
            ...(b.dataset.audio ? { audio: b.dataset.audio } : {}),
          },
          b,
        );
      }),
    );
    const guidance = content.querySelector("#support-guidance");
    const guidanceText = {
      download:
        "Use Seasons & episodes to download missing episodes or find alternatives. A transfer with no peers needs a different source; priority cannot fix it.",
      playback:
        "Try another client or lower playback quality. Disable subtitles temporarily to check whether subtitle transcoding is the cause. If it fails across devices, report the file.",
      "wrong-episode":
        "Check the episode title and season. A wrong imported file needs a replacement, not another season request.",
      audio:
        "Select the desired audio track in your player. The verified file tracks above describe the imported file; advertised release languages may differ.",
      subtitles:
        "Enable an existing subtitle track or use the player’s subtitle search. If none is usable, include the language and whether subtitles are missing or out of sync.",
      other:
        "Describe what you expected and what happened. Your report stays open until you confirm it works.",
    };
    const category = /** @type {HTMLSelectElement} */ (content.querySelector('[name="category"]'));
    category.onchange = () => {
      guidance.textContent = guidanceText[category.value];
    };
    category.onchange(new Event("change"));
    content.querySelectorAll("[data-action]").forEach((el) =>
      el.addEventListener("click", async () => {
        const b = /** @type {HTMLButtonElement} */ (el);
        const action = b.dataset.action;
        if (
          !confirm(
            action === "refresh-library"
              ? "Refresh the download library’s file status for this title only? This does not start downloads. Plex and Seerr may take another scan to catch up."
              : action === "priority"
                ? "Move this shared transfer to the top of the torrent queue? This affects everyone downloading its episodes. Other transfers will not be paused. You can do this once per transfer every 30 minutes."
                : "Retry automatic import for this completed transfer? The service will retain its normal matching and quality rules.",
          )
        )
          return;
        b.disabled = true;
        try {
          const r = await apiPost("/api/support/action", {
            action,
            tmdbId: target.tmdbId,
            queueId: Number(b.dataset.queue),
            instance: b.dataset.instance,
            confirmed: true,
          });
          toast(r.error || r.message);
        } catch {
          toast("Could not confirm the action. Refresh before retrying.");
        } finally {
          b.disabled = false;
        }
      }),
    );
    /** @type {HTMLFormElement} */ (content.querySelector("form")).onsubmit = async (e) => {
      e.preventDefault();
      const form = /** @type {HTMLFormElement} */ (e.currentTarget);
      const button = /** @type {HTMLButtonElement} */ (form.querySelector('button[type="submit"]'));
      button.disabled = true;
      try {
        const fields = Object.fromEntries(new FormData(form));
        const r = await apiPost("/api/support/reports", { ...target, ...fields });
        if (r.error) throw new Error(r.error);
        content.querySelector("#report-result").textContent =
          "Report saved. Track it in Requests → Problems. It stays open until playback works.";
      } catch (e) {
        content.querySelector("#report-result").textContent = e.message;
      } finally {
        button.disabled = false;
      }
    };
    content.querySelector("#save-preferences").addEventListener("click", async () => {
      const r = await apiPost("/api/support/preferences", {
        audio: /** @type {HTMLSelectElement} */ (content.querySelector("#audio-pref")).value,
        subtitles: /** @type {HTMLSelectElement} */ (content.querySelector("#subtitle-pref")).value,
      });
      toast(r.error || "Preferences saved");
    });
  } catch {
    content.textContent =
      "Diagnostics are unavailable. Try again shortly or contact your administrator if the service is down.";
  }
}
/** @param {string} selected */
function languageOptions(selected) {
  return Object.entries({
    original: "Original language",
    eng: "English",
    lit: "Lithuanian",
    rus: "Russian",
    jpn: "Japanese",
    any: "Any",
    none: "None",
  })
    .map(([v, l]) => `<option value="${v}" ${v === selected ? "selected" : ""}>${l}</option>`)
    .join("");
}
export async function openReports() {
  const { content } = sheet("Problems");
  content.textContent = "Loading reports…";
  try {
    const { reports } = await api("/api/support/reports");
    content.innerHTML = reports.length
      ? reports
          .map(
            (r) =>
              `<article class="support-library"><p class="section-kicker">${escHtml(r.title || r.type)} · TMDB ${r.tmdbId}${r.episodeId ? ` · episode ${r.episodeId}` : ""}</p><h3>${escHtml(reasons[r.category] || r.category)}</h3>${r.snapshot ? `<details><summary>Reported conditions</summary>${r.snapshot.services.map((s) => `<p>${escHtml(s.instance)} · ${s.reachable ? "Reachable" : "Unavailable"} · ${s.monitored ? "Monitored" : "Not monitored"}${s.problems.map((p) => `<br>${escHtml(p)}`).join("")}</p>`).join("")}</details>` : ""}<p class="report-state">${escHtml(r.status.replaceAll("_", " "))}</p><p>${escHtml(r.device)} ${escHtml(r.notes)}</p>${r.history.map((h) => `<p class="support-muted">${escHtml(new Date(h.at).toLocaleString())} · ${escHtml(h.message)}</p>`).join("")}${getUserState().isAdmin ? `<label>Update for the user<textarea maxlength="1000" data-note="${r.id}" rows="2"></textarea></label><button class="quick-btn secondary" data-note-send="${r.id}">Post update</button>` : ""}<button class="quick-btn secondary" data-check="${r.id}">Check again</button><button class="quick-btn secondary" data-report="${r.id}" data-status="${r.status === "resolved" ? "open" : "resolved"}">${r.status === "resolved" ? "Still broken — reopen" : "Works now"}</button>${getUserState().isAdmin && r.status !== "resolved" ? `<button class="quick-btn secondary" data-report="${r.id}" data-status="investigating">Mark investigating (admin)</button>` : ""}</article>`,
          )
          .join("")
      : "<p>No reported problems. Open a title and choose Having trouble? when you need help.</p>";
    content.querySelectorAll("[data-note-send]").forEach((el) =>
      el.addEventListener("click", async () => {
        const id = /** @type {HTMLElement} */ (el).dataset.noteSend;
        const input = /** @type {HTMLTextAreaElement} */ (
          content.querySelector(`[data-note="${id}"]`)
        );
        if (!input.value.trim()) return;
        const r = await apiPost("/api/support/reports", {
          id,
          status: "investigating",
          message: input.value,
        });
        if (r.error) toast(r.error);
        else void openReports();
      }),
    );
    content
      .querySelectorAll("[data-check]")
      .forEach((el) =>
        el.addEventListener("click", () =>
          openSupport(reports.find((r) => r.id === /** @type {HTMLElement} */ (el).dataset.check)),
        ),
      );
    content.querySelectorAll("[data-report]").forEach((el) =>
      el.addEventListener("click", async () => {
        const d = /** @type {HTMLElement} */ (el).dataset;
        const r = await apiPost("/api/support/reports", { id: d.report, status: d.status });
        if (r.error) toast(r.error);
        else void openReports();
      }),
    );
  } catch {
    content.textContent = "Could not load reports. Try again.";
  }
}
export async function openServiceStatus() {
  const { content } = sheet("Service status");
  content.textContent = "Checking…";
  try {
    const d = await api("/api/support/status");
    content.innerHTML = `<p>${escHtml(d.scope)}</p>${d.services.map((s) => `<p>${s.available ? "✓" : "⚠"} ${escHtml(s.name)} · ${s.available ? "Reachable" : "Unavailable"}</p>`).join("")}<p class="support-muted">Checked ${escHtml(new Date(d.checkedAt).toLocaleString())}</p>${d.externalStatusUrl ? `<a href="${escHtml(d.externalStatusUrl)}" target="_blank" rel="noopener noreferrer">Independent status page ↗</a>` : ""}`;
  } catch {
    content.textContent =
      "Teleseerr cannot reach the status service. Check the independent status page or contact the administrator.";
  }
}
/** @param {any} item @returns {Promise<void>} */
export async function editPendingRequest(item) {
  const { content } = sheet("Edit pending request");
  content.textContent = "Loading seasons…";
  try {
    const show = await api(`/api/tv/${item.tmdbId}`);
    content.innerHTML = `<p>Choose seasons for your pending request. Approved shared downloads stay in the library.</p><form>${show.seasons.map((s) => `<label class="pending-season"><input type="checkbox" name="season" value="${s.seasonNumber}" ${(item.seasons ?? []).includes(s.seasonNumber) ? "checked" : ""}>${s.seasonNumber === 0 ? "Specials" : `Season ${s.seasonNumber}`} · ${s.episodeCount} episodes</label>`).join("")}<button class="quick-btn" type="submit">Save season selection</button><p role="status"></p></form>`;
    /** @type {HTMLFormElement} */ (content.querySelector("form")).onsubmit = async (e) => {
      e.preventDefault();
      const form = /** @type {HTMLFormElement} */ (e.currentTarget);
      const seasons = new FormData(form).getAll("season").map(Number);
      if (!seasons.length) {
        toast("Choose at least one season, or cancel the request from Requests.");
        return;
      }
      if (
        !confirm(
          `Update this pending request to ${seasons.length} seasons: ${seasons.map((s) => `S${s}`).join(", ")}?`,
        )
      )
        return;
      const b = /** @type {HTMLButtonElement} */ (form.querySelector("button"));
      b.disabled = true;
      try {
        const r = await apiPost("/api/requests/change", {
          id: item.id,
          action: "edit",
          seasons,
          confirmed: true,
        });
        form.querySelector('[role="status"]').textContent = r.error || r.message;
      } catch {
        toast("Could not confirm the change. Refresh before retrying.");
      } finally {
        b.disabled = false;
      }
    };
  } catch {
    content.textContent = "Could not load this request's seasons. Try again shortly.";
  }
}
