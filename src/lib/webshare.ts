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

async function fetchWebshareProxyRecord(apiKey: string): Promise<WebshareProxyRecord | null> {
  const endpoints = [
    "https://proxy.webshare.io/api/v2/proxy/list/?mode=backbone&page=1&page_size=1",
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
      if ((record?.proxy_address || record?.port) && record.username && record.password) {
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
    if (parsed) {
      return parsed;
    }
  }

  if (!config.webshareApiKey) {
    return null;
  }

  const record = await fetchWebshareProxyRecord(config.webshareApiKey);
  if ((!record?.proxy_address && !record?.port) || !record.username || !record.password) {
    return null;
  }

  const host = record.proxy_address ?? "p.webshare.io";
  const port = record.ports?.http ?? record.port ?? 80;
  return {
    server: `http://${host}:${port}`,
    username: record.username,
    password: record.password,
  };
}
