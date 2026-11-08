// Browser history owns navigation; search text stays in local history state.
const tabs = { trending: "/discover", movies: "/movies", tv: "/tv", anime: "/anime", requests: "/requests", admin: "/people", profile: "/you" };
let handler;
let position = 0;
let generation = 0;
function dispatch(route,state) {
  const version = ++generation;
  void Promise.resolve(handler(route,state)).then(() => {
    if (version === generation) window.scrollTo(0, Number(state.scroll) || 0);
  }).catch(() => console.warn("Could not render this screen"));
}
export function tabPath(tab) { return tabs[tab] ?? "/discover"; }
/** @param {string} path */
export function parseRoute(path) {
  const tab = Object.entries(tabs).find(([, value]) => value === path);
  if (tab) return { kind: "tab", tab: tab[0], path };
  const match = /^\/(movie|tv|person)\/([1-9]\d*)$/.exec(path);
  if (match && Number.isSafeInteger(Number(match[2]))) return { kind: match[1] === "person" ? "person" : "detail", type: match[1], id: Number(match[2]), path };
  if (path === "/search") return { kind: "search", path };
  return { kind: "tab", tab: "trending", path: "/discover" };
}
export function routerReady() { return !!handler; }
/** @param {string} path @param {{replace?:boolean, query?:string}} [options] */
export function navigate(path, options = {}) {
  if (!handler) return;
  const route = parseRoute(path);
  const current = history.state?.teleseerr;
  const same = location.pathname === route.path;
  if (!same) history.replaceState({teleseerr:{...current,position:current?.position ?? position,scroll:window.scrollY}}, "");
  if (!same && !options.replace) position = (current?.position ?? position) + 1;
  const state = { teleseerr: { position, ...(route.kind === "search" ? { query: options.query ?? current?.query ?? "" } : {}) } };
  if (same || options.replace) history.replaceState(state, "", route.path);
  else history.pushState(state, "", route.path);
  dispatch(route, state.teleseerr);
}
/** @param {string} [fallback] */
export function backRoute(fallback = "/discover") {
  if ((history.state?.teleseerr?.position ?? 0) > 0) history.back();
  else navigate(fallback, { replace: true });
}
/** @param {(route:any,state:any)=>void|Promise<void>} render */
export function startRouter(render) {
  if (handler) return;
  handler = render;
  history.scrollRestoration = "manual";
  position = history.state?.teleseerr?.position ?? 0;
  addEventListener("popstate", () => {
    position = history.state?.teleseerr?.position ?? 0;
    const route = parseRoute(location.pathname);
    if (route.path !== location.pathname) navigate(route.path, {replace:true});
    else dispatch(route, history.state?.teleseerr ?? {});
  });
  navigate(parseRoute(location.pathname).path, {replace:true});
}
