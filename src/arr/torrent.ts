import type { ArrInstance } from "./client.js";
import { arr, type QueueItem } from "../routes/downloads.js";
import { ClientError } from "../http.js";
import { config } from "../config.js";
import { serviceUrl } from "../transport.js";

type Client = {
  id: number;
  enable: boolean;
  implementation: string;
  fields: { name: string; value: unknown }[];
};
export type Torrent = {
  hash: string;
  state: string;
  dlspeed: number;
  num_seeds: number;
  num_leechs: number;
  progress: number;
  last_activity: number;
  priority: number;
};
export async function torrentClient(
  instance: ArrInstance,
  item: QueueItem,
): Promise<{ info: Torrent; prioritize: () => Promise<void> }> {
  if (!/^[a-f0-9]{40,64}$/i.test(item.downloadId))
    throw new ClientError(409, "Torrent identity unavailable");
  const clients = (await arr<Client[]>(instance, "downloadclient")).filter(
    (c) => c.enable && c.implementation === "QBittorrent",
  );
  const client =
    clients.find((c) => c.id === item.downloadClientId) ??
    (clients.length === 1 ? clients[0] : undefined);
  if (!client) throw new ClientError(409, "A unique qBittorrent client could not be mapped");
  const fields = Object.fromEntries(client.fields.map((f) => [f.name, f.value]));
  const fieldText = (name: string): string =>
    typeof fields[name] === "string" ? fields[name] : "";
  const host = fieldText("host");
  const port = Number(fields["port"]);
  if (!/^[a-z0-9.:-]+$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new ClientError(502, "Invalid configured torrent client");
  const base = serviceUrl(
    `${fields["useSsl"] ? "https" : "http"}://${host}:${port}${fieldText("urlBase")}`,
    "torrent client",
    config.ALLOW_INSECURE_HTTP,
  );
  const override = config.QBITTORRENT_URL === base && !!config.QBITTORRENT_PASSWORD;
  const username = override ? config.QBITTORRENT_USERNAME : fieldText("username");
  const password = override ? config.QBITTORRENT_PASSWORD : fieldText("password");
  if (!password || /^[*•]+$/.test(password))
    throw new ClientError(
      502,
      "Torrent credentials are redacted by the download service. Ask the administrator to configure the torrent integration.",
    );
  const cookie = await loginCookie(base, username, password);
  const call = async (path: string, body?: URLSearchParams): Promise<Response> => {
    const response = await fetch(`${base}/api/v2/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Cookie: cookie, Referer: `${base}/` },
      ...(body ? { body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) sessions.delete(base);
      throw new ClientError(502, "Torrent client action could not be confirmed");
    }
    return response;
  };
  const infos = (await (
    await call(`torrents/info?hashes=${encodeURIComponent(item.downloadId)}`)
  ).json()) as Torrent[];
  const info = infos.find((t) => t.hash.toLowerCase() === item.downloadId.toLowerCase());
  if (!info) throw new ClientError(409, "Transfer is no longer in the torrent client");
  return {
    info,
    prioritize: async () => {
      const preferences = (await (await call("app/preferences")).json()) as {
        queueing_enabled?: boolean;
      };
      if (!preferences.queueing_enabled)
        throw new ClientError(
          409,
          "Torrent queueing is disabled. Priority would have no effect; use Find alternatives for a stalled source.",
        );
      await (
        await call("torrents/topPrio", new URLSearchParams({ hashes: info.hash }))
      ).body?.cancel();
      const updated = (await (
        await call(`torrents/info?hashes=${encodeURIComponent(info.hash)}`)
      ).json()) as Torrent[];
      if (updated.find((t) => t.hash.toLowerCase() === info.hash.toLowerCase())?.priority !== 1)
        throw new ClientError(
          502,
          "Priority change could not be confirmed. Refresh before trying again.",
        );
    },
  };
}

const sessions = new Map<string, { at: number; cookie: Promise<string> }>();
async function loginCookie(base: string, username: string, password: string): Promise<string> {
  const current = sessions.get(base);
  if (current && Date.now() - current.at < 120000) return current.cookie;
  const cookie = (async () => {
    const response = await fetch(`${base}/api/v2/auth/login`, {
      method: "POST",
      body: new URLSearchParams({ username, password }),
      headers: { Referer: `${base}/` },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const accepted = response.status === 204 || (await response.text()).trim() === "Ok.";
    if (!response.ok || !accepted || !/^SID=.+/.test(cookie))
      throw new ClientError(502, "Torrent client login unavailable");
    return cookie;
  })();
  sessions.set(base, { at: Date.now(), cookie });
  try {
    return await cookie;
  } catch (error) {
    sessions.delete(base);
    throw error;
  }
}
