const state = document.getElementById("state");
const detail = document.getElementById("detail");
const checked = document.getElementById("checked");
const retry = document.getElementById("retry");
let checking = false;

async function loadObservation() {
  const background = document.getElementById("background");
  try {
    const response = await fetch(`./status.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw Error();
    const observation = await response.json();
    const time = Date.parse(observation.checkedAt);
    if (!Number.isFinite(time) || !Array.isArray(observation.services)) throw Error();
    const app = observation.services.find(service => service.name === "Teleseerr");
    const age = Date.now() - time;
    const old = age > 45 * 60_000 || age < -60_000;
    const when = new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    background.textContent = `Last background check: ${when}${app ? ` · ${app.available ? "reachable" : "unreachable"}` : ""}.${old ? " The background monitor is delayed; use the live check above." : ""}`;
    const others = observation.services.filter(service => service.name !== "Teleseerr");
    const other = document.getElementById("other-services");
    other.hidden = !others.length;
    other.textContent = others.map(service => `${service.name}: ${old ? "last seen " : ""}${service.available ? "reachable" : "unreachable"}`).join(" · ");
  } catch {
    background.textContent = "The background monitor is unavailable. The live check above works separately.";
  }
}

async function checkStatus() {
  if (checking) return;
  checking = true;
  retry.disabled = true;
  state.textContent = "Checking…";
  delete state.dataset.state;
  const started = performance.now();
  try {
    const response = await fetch(`https://teleseerr.cn.lt/health?t=${Date.now()}`, {
      cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || (await response.json()).status !== "ok") throw Error();
    state.dataset.state = "online";
    state.textContent = "Online";
    detail.textContent = `The app is reachable from this browser · ${Math.round(performance.now() - started)} ms.`;
  } catch {
    state.dataset.state = "unknown";
    state.textContent = "Connection problem";
    detail.textContent = "This browser couldn’t reach the app. Check your connection or try again. This alone doesn’t confirm a server outage.";
  } finally {
    checked.textContent = `Checked just now · ${new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
    checking = false;
    retry.disabled = false;
  }
}
retry.addEventListener("click", () => { void checkStatus(); void loadObservation(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { void checkStatus(); void loadObservation(); } });
setInterval(() => { if (!document.hidden) { void checkStatus(); void loadObservation(); } }, 60_000);
void checkStatus();
void loadObservation();
