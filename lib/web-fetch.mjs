import { lookup } from "node:dns/promises";

const BLOCKED_HOSTS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "::1",
  "metadata.google.internal", "169.254.169.254",
]);

const MAX_BODY_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_CHARS = 8000;

function isPrivateIp(ip) {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (ip.startsWith("fe80")) return true;
  const parts = ip.split(".");
  if (parts.length === 4 && parts[0] === "172") {
    const second = parseInt(parts[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

async function isBlockedUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { blocked: true, reason: "Invalid URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { blocked: true, reason: `Blocked scheme: ${parsed.protocol}` };
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) {
    return { blocked: true, reason: `Blocked host: ${host}` };
  }
  if (isPrivateIp(host)) {
    return { blocked: true, reason: `Blocked private IP: ${host}` };
  }
  try {
    const resolved = await lookup(host);
    if (isPrivateIp(resolved.address)) {
      return { blocked: true, reason: `Host ${host} resolves to private IP ${resolved.address}` };
    }
  } catch {
    return { blocked: true, reason: `DNS resolution failed for ${host}` };
  }
  return { blocked: false };
}

function stripHtml(html) {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/&amp;/gi, "&");
  text = text.replace(/&lt;/gi, "<");
  text = text.replace(/&gt;/gi, ">");
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/\s+/g, " ");
  return text.trim();
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : null;
}

function extractMetaDescription(html) {
  const m = html.match(/<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([\s\S]*?)["'][^>]*>/i)
    || html.match(/<meta[^>]+content\s*=\s*["']([\s\S]*?)["'][^>]+name\s*=\s*["']description["'][^>]*>/i);
  return m ? m[1].trim() : null;
}

function extractHeadings(html) {
  const headings = [];
  const regex = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match;
  while ((match = regex.exec(html)) !== null && headings.length < 20) {
    const text = match[2].replace(/<[^>]+>/g, "").trim();
    if (text) headings.push({ level: parseInt(match[1], 10), text });
  }
  return headings;
}

function extractLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const regex = /<a[^>]+href\s*=\s*["']([^"'#]+?)["'][^>]*>/gi;
  let match;
  while ((match = regex.exec(html)) !== null && links.length < 30) {
    let href = match[1].trim();
    if (href.startsWith("mailto:") || href.startsWith("javascript:") || href.startsWith("tel:")) continue;
    try {
      const resolved = new URL(href, baseUrl).href;
      if (!seen.has(resolved)) {
        seen.add(resolved);
        links.push(resolved);
      }
    } catch { /* skip malformed */ }
  }
  return links;
}

function extractSocialLinks(links) {
  const social = {};
  for (const link of links) {
    const lower = link.toLowerCase();
    if (lower.includes("twitter.com/") || lower.includes("x.com/")) {
      if (!social.twitter) social.twitter = link;
    } else if (lower.includes("t.me/") || lower.includes("telegram.")) {
      if (!social.telegram) social.telegram = link;
    } else if (lower.includes("discord.gg/") || lower.includes("discord.com/")) {
      if (!social.discord) social.discord = link;
    } else if (lower.includes("github.com/")) {
      if (!social.github) social.github = link;
    } else if (lower.includes("medium.com/") || lower.includes(".medium.com")) {
      if (!social.medium) social.medium = link;
    }
  }
  return social;
}

async function readBodyWithLimit(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new Error(`Response too large: ${buf.byteLength} bytes (max ${maxBytes})`);
    return new Uint8Array(buf);
  }

  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      reader.cancel();
      throw new Error(`Response too large: exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function fetchUrl(url) {
  const blockCheck = await isBlockedUrl(url);
  if (blockCheck.blocked) {
    return { ok: false, error: blockCheck.reason, url };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TraderClaw/1.0; +https://traderclaw.com)",
        "Accept": "text/html,application/xhtml+xml,application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} ${response.statusText}`, url };
    }

    const finalUrl = response.url;
    const finalCheck = await isBlockedUrl(finalUrl);
    if (finalCheck.blocked) {
      return { ok: false, error: `Redirect to blocked URL: ${finalCheck.reason}`, url };
    }

    const contentType = response.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");
    const isHtml = contentType.includes("text/html") || contentType.includes("text/xhtml");
    const isText = contentType.includes("text/plain");

    let bodyBytes;
    try {
      bodyBytes = await readBodyWithLimit(response, MAX_BODY_BYTES);
    } catch (sizeErr) {
      return { ok: false, error: sizeErr.message, url };
    }

    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bodyBytes);

    if (isJson) {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }
      const jsonStr = parsed ? JSON.stringify(parsed, null, 2) : raw;
      return {
        ok: true,
        url,
        finalUrl,
        contentType: "json",
        title: null,
        metaDescription: null,
        headings: [],
        socialLinks: {},
        outboundLinks: [],
        bodyText: jsonStr.slice(0, MAX_OUTPUT_CHARS),
        bodyTruncated: jsonStr.length > MAX_OUTPUT_CHARS,
      };
    }

    if (isHtml || (!isText && !isJson)) {
      const title = extractTitle(raw);
      const metaDescription = extractMetaDescription(raw);
      const headings = extractHeadings(raw);
      const allLinks = extractLinks(raw, finalUrl);
      const socialLinks = extractSocialLinks(allLinks);
      const bodyText = stripHtml(raw).slice(0, MAX_OUTPUT_CHARS);

      return {
        ok: true,
        url,
        finalUrl,
        contentType: "html",
        title,
        metaDescription,
        headings,
        socialLinks,
        outboundLinks: allLinks.slice(0, 20),
        bodyText,
        bodyTruncated: stripHtml(raw).length > MAX_OUTPUT_CHARS,
      };
    }

    return {
      ok: true,
      url,
      finalUrl,
      contentType: "text",
      title: null,
      metaDescription: null,
      headings: [],
      socialLinks: {},
      outboundLinks: [],
      bodyText: raw.slice(0, MAX_OUTPUT_CHARS),
      bodyTruncated: raw.length > MAX_OUTPUT_CHARS,
    };

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      return { ok: false, error: `Request timed out after ${FETCH_TIMEOUT_MS}ms`, url };
    }
    return { ok: false, error: err.message || String(err), url };
  }
}

export function registerWebFetchTool(api, Type, logPrefix, options) {
  const checkPermission = options?.checkPermission || null;

  const json = (data) => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  });

  api.registerTool({
    name: "web_fetch_url",
    description: "Fetch a URL and return its content as structured text. Extracts title, meta description, headings, social links, outbound links, and body text from HTML pages. Returns raw JSON for JSON responses. Use for analyzing token project websites, metadata URIs, and verifying social link legitimacy. Results should be cached in memory — do not re-fetch the same URL within 48 hours.",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch (must be http:// or https://)" }),
    }),
    execute: async (toolCallId, params) => {
      try {
        if (checkPermission) {
          const callingAgentId = params?._agentId || "main";
          const permError = checkPermission("web_fetch_url", callingAgentId);
          if (permError) {
            return json({ error: permError, tool: "web_fetch_url", agentId: callingAgentId });
          }
        }

        const { url } = params;
        api.logger.info(`${logPrefix} web_fetch_url: fetching ${url}`);

        const result = await fetchUrl(url);

        if (!result.ok) {
          api.logger.warn(`${logPrefix} web_fetch_url failed for ${url}: ${result.error}`);
          return json({ ok: false, error: result.error, url });
        }

        api.logger.info(`${logPrefix} web_fetch_url: success for ${url} (${result.contentType}, title: ${result.title || "none"})`);
        return json(result);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  api.logger.info(`${logPrefix} Registered web_fetch_url tool (website analysis, metadata URI inspection)`);
}
