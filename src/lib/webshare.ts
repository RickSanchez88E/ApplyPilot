import { createChildLogger } from "./logger.js";
import { getConfig } from "../shared/config.js";

const log = createChildLogger({ module: "webshare" });

export interface BrowserProxyConfig {
  readonly server: string;
  readonly username?: string;
  readonly password?: string;
}

interface WebshareProxyRecord {
  readonly username?: string;
  readonly password?: string;
  readonly proxy_address?: string;
  readonly port?: number;
  readonly ports?: { readonly http?: number; readonly socks5?: number };
}

export function parseProxyUrl(proxyUrl: string): BrowserProxyConfig | null {
  if (!proxyUrl) return null;

  try {
    const parsed = new URL(proxyUrl);
    return {
      server: `${parsed.protocol}//${parsed.host}`,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
    };
  } catch (err) {
    log.warn({ err }, "Failed to parse proxy URL");
    return null;
  }
}

function isPlaceholderProxyUrl(proxyUrl: string): boolean {
  return (
    !proxyUrl ||
    proxyUrl.includes("replace_with_username") ||
    proxyUrl.includes("replace_with_password")
  );
}

function recordToBrowserConfig(record: WebshareProxyRecord): BrowserProxyConfig | null {
  if (!record.username || !record.password) return null;
  if (!record.proxy_address && !record.port && !record.ports?.http) return null;
  const host = record.proxy_address ?? "p.webshare.io";
  const port = record.ports?.http ?? record.port ?? 80;
  return {
    server: `http://${host}:${port}`,
    username: record.username,
    password: record.password,
  };
}

/**
 * List multiple distinct proxy endpoints from Webshare API (for parallel browser contexts).
 * Residential plans typically use `mode=backbone` (see Webshare API docs).
 *
 * @param count — how many proxy configs to return (e.g. 3 for 3 IPs)
 * @param options.mode — override; else `WEBSHARE_PROXY_LIST_MODE` or `backbone`, then fallback `direct`
 */
export async function listWebshareBrowserProxies(
  count: number,
  options?: { mode?: string },
): Promise<BrowserProxyConfig[]> {
  const apiKey = getConfig().webshareApiKey;
  if (!apiKey) {
    throw new Error("WEBSHARE_API_KEY is required to list proxies");
  }

  // Prefer download token — authoritative for residential plans
  const residential = await fetchResidentialProxyList(apiKey, count);
  if (residential.length >= count) return residential.slice(0, count);

  // Fallback: datacenter via list API
  const out: BrowserProxyConfig[] = [...residential];
  const seen = new Set(out.map((p) => `${p.server}|${p.username}`));

  const tryModes = options?.mode
    ? [options.mode]
    : ["direct"];

  for (const mode of tryModes) {
    if (out.length >= count) break;

    const pageSize = Math.min(Math.max(count * 2, 10), 100);
    const url = `https://proxy.webshare.io/api/v2/proxy/list/?mode=${encodeURIComponent(mode)}&page=1&page_size=${pageSize}`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Token ${apiKey}` },
      });

      if (!response.ok) {
        log.warn({ mode, status: response.status }, "Webshare proxy list request failed");
        continue;
      }

      const body = (await response.json()) as { readonly results?: WebshareProxyRecord[] };

      for (const record of body.results ?? []) {
        const cfg = recordToBrowserConfig(record);
        if (!cfg) continue;
        const key = `${cfg.server}|${cfg.username}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cfg);
        if (out.length >= count) break;
      }
    } catch (err) {
      log.warn({ err, mode }, "Webshare list fetch error");
    }
  }

  if (out.length < count) {
    log.warn({ requested: count, got: out.length }, "Fewer proxies than requested from Webshare");
  }

  return out.slice(0, count);
}

/**
 * Residential proxies (backbone mode) use a download-token endpoint that returns
 * the authoritative `host:port:username:password` per line.
 * The list API returns misleading port/address for residential plans.
 */
async function fetchResidentialProxyList(
  apiKey: string,
  count: number,
): Promise<BrowserProxyConfig[]> {
  try {
    const cfgRes = await fetch("https://proxy.webshare.io/api/v2/proxy/config/", {
      headers: { Authorization: `Token ${apiKey}` },
    });
    if (!cfgRes.ok) return [];
    const cfg = (await cfgRes.json()) as { proxy_list_download_token?: string };
    const token = cfg.proxy_list_download_token;
    if (!token) return [];

    const modes = [process.env.WEBSHARE_PROXY_LIST_MODE ?? "backbone", "direct"];
    for (const mode of modes) {
      try {
        const dlRes = await fetch(
          `https://proxy.webshare.io/api/v2/proxy/list/download/${token}/-/any/username/${mode}/-/`,
        );
        if (!dlRes.ok) continue;
        const text = await dlRes.text();

        const proxies: BrowserProxyConfig[] = [];
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const parts = trimmed.split(":");
          if (parts.length < 4) continue;
          const [host, portStr, username, password] = parts;
          proxies.push({
            server: `http://${host}:${portStr}`,
            username,
            password,
          });
          if (proxies.length >= count) break;
        }

        if (proxies.length > 0) {
          log.info({ mode, count: proxies.length }, "Fetched residential proxies via download token");
          return proxies;
        }
      } catch (err) {
        log.warn({ err, mode }, "Residential proxy download failed for mode");
      }
    }
  } catch (err) {
    log.warn({ err }, "Failed to fetch residential proxy config");
  }
  return [];
}

async function fetchWebshareProxyRecord(apiKey: string): Promise<WebshareProxyRecord | null> {
  const endpoints = [
    "https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=1",
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: { Authorization: `Token ${apiKey}` },
      });

      if (!response.ok) {
        log.warn({ endpoint, status: response.status }, "Webshare API returned non-200 status");
        continue;
      }

      const body = (await response.json()) as { readonly results?: WebshareProxyRecord[] };
      const record = body.results?.[0];
      if (record?.proxy_address && record.username && record.password) {
        return record;
      }
    } catch (err) {
      log.warn({ err, endpoint }, "Failed to fetch proxy from Webshare API");
    }
  }

  return null;
}

export async function getBrowserProxyConfig(): Promise<BrowserProxyConfig | null> {
  const config = getConfig();

  if (!isPlaceholderProxyUrl(config.webshareProxyUrl)) {
    const parsed = parseProxyUrl(config.webshareProxyUrl);
    if (parsed) return parsed;
  }

  if (!config.webshareApiKey) return null;

  // Residential proxies: download token gives correct host:port:user:pass
  const residential = await fetchResidentialProxyList(config.webshareApiKey, 1);
  if (residential.length > 0) return residential[0]!;

  // Datacenter fallback via list API
  const record = await fetchWebshareProxyRecord(config.webshareApiKey);
  return record ? recordToBrowserConfig(record) : null;
}
