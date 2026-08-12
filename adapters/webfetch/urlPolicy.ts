import { WebFetchError } from "../../services/webfetch/contracts.js";

export interface ResolvedWebTarget {
  url: URL;
}

export function resolveWebTarget(input: string | URL): ResolvedWebTarget {
  return { url: parseWebUrl(input) };
}

export function parseWebUrl(input: string | URL) {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new WebFetchError("URL_NOT_ALLOWED", "Invalid URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    throw new WebFetchError("URL_NOT_ALLOWED", "Unsupported URL protocol.");
  }
  if (url.username || url.password) {
    throw new WebFetchError("URL_NOT_ALLOWED", "URL credentials are not allowed.");
  }
  url.hash = "";
  return url;
}

export function normalizedHostname(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, "");
}
