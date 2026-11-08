/** Keep an open Mini App aware of releases without interrupting an action or draft. */
export function watchForUpdates() {
  const current = document.querySelector('meta[name="app-version"]')?.getAttribute("content");
  if (!current) return;
  let checking = false;
  async function check() {
    if (checking || document.hidden || document.getElementById("app-update")) return;
    checking = true;
    try {
      const response = await fetch("/health", { cache: "no-store" });
      if (!response.ok) return;
      const { frontendVersion } = await response.json();
      if (typeof frontendVersion !== "string" || frontendVersion === current) return;
      const notice = document.createElement("aside");
      notice.id = "app-update";
      notice.className = "app-update";
      notice.setAttribute("role", "status");
      notice.innerHTML = '<span>A new version is ready.</span><button type="button">Reload app</button>';
      notice.querySelector("button").onclick = () => location.reload();
      document.querySelector(".top-bar")?.after(notice);
    } catch { /* An offline session can keep working; retry when it returns. */ }
    finally { checking = false; }
  }
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
  setInterval(check, 60_000);
  void check();
}
