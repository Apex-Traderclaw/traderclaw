import {
  AlphaBuffer
} from "./chunk-3UQIQJPQ.js";
import {
  AlphaStreamManager
} from "./chunk-3YPZOXWE.js";
import {
  orchestratorRequest
} from "./chunk-T4YWGIIR.js";
import {
  SessionManager
} from "./chunk-QSICXLW7.js";

// index.ts
import { Type } from "@sinclair/typebox";

// lib/x-client.mjs
import { createHmac, randomBytes } from "crypto";
var X_API_BASE = "https://api.twitter.com/2";
var MAX_TWEET_LENGTH = 280;
function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function generateNonce() {
  return randomBytes(16).toString("hex");
}
function generateTimestamp() {
  return Math.floor(Date.now() / 1e3).toString();
}
function buildBaseString(method, url, params) {
  const sorted = Object.keys(params).sort().map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join("&");
  return `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(sorted)}`;
}
function signRequest(method, url, oauthParams, consumerSecret, tokenSecret) {
  const baseString = buildBaseString(method, url, oauthParams);
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac("sha1", signingKey).update(baseString).digest("base64");
}
function buildAuthHeader(method, url, credentials, queryParams = {}) {
  const oauthParams = {
    oauth_consumer_key: credentials.consumerKey,
    oauth_nonce: generateNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: generateTimestamp(),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
    ...queryParams
  };
  const signature = signRequest(
    method,
    url,
    oauthParams,
    credentials.consumerSecret,
    credentials.accessTokenSecret
  );
  oauthParams.oauth_signature = signature;
  const headerParts = Object.keys(oauthParams).filter((k) => k.startsWith("oauth_")).sort().map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`).join(", ");
  return `OAuth ${headerParts}`;
}
async function xApiFetch(method, endpoint, credentials, { body = null, queryParams = {} } = {}) {
  const url = `${X_API_BASE}${endpoint}`;
  const queryString = Object.keys(queryParams).length > 0 ? "?" + Object.entries(queryParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
  const fullUrl = `${url}${queryString}`;
  const authHeader = buildAuthHeader(method, url, credentials, method === "GET" ? queryParams : {});
  const headers = {
    Authorization: authHeader,
    "User-Agent": "TraderClaw-Team/1.0"
  };
  const fetchOpts = { method, headers };
  if (body && method !== "GET") {
    headers["Content-Type"] = "application/json";
    fetchOpts.body = JSON.stringify(body);
  }
  const response = await fetch(fullUrl, fetchOpts);
  const responseText = await response.text();
  let responseData;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    responseData = { raw: responseText };
  }
  const rateLimitRemaining = response.headers.get("x-rate-limit-remaining");
  const rateLimitReset = response.headers.get("x-rate-limit-reset");
  if (!response.ok) {
    if (response.status === 429) {
      const resetTime = rateLimitReset ? new Date(parseInt(rateLimitReset) * 1e3).toISOString() : "unknown";
      return {
        ok: false,
        error: `Rate limited. Resets at ${resetTime}.`,
        status: 429,
        resetAt: resetTime,
        data: responseData
      };
    }
    if (response.status === 401) {
      return {
        ok: false,
        error: "Authentication failed. Check your X API credentials (consumer key/secret and access token/secret). Ensure the app has Read+Write permissions and tokens were regenerated after permission change.",
        status: 401,
        data: responseData
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        error: "Forbidden. Your X API tier may not support this endpoint. Free tier is write-only (posting). Upgrade to Basic ($200/mo) or pay-as-you-go for read access (mentions, search).",
        status: 403,
        data: responseData
      };
    }
    return {
      ok: false,
      error: `X API error ${response.status}: ${responseData?.detail || responseData?.title || responseText.slice(0, 200)}`,
      status: response.status,
      data: responseData
    };
  }
  return {
    ok: true,
    status: response.status,
    data: responseData,
    rateLimitRemaining: rateLimitRemaining ? parseInt(rateLimitRemaining) : void 0
  };
}
function validateTweetText(text) {
  if (!text || typeof text !== "string") {
    return { valid: false, error: "Tweet text is required and must be a non-empty string." };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: "Tweet text cannot be empty." };
  }
  if (trimmed.length > MAX_TWEET_LENGTH) {
    return { valid: false, error: `Tweet exceeds ${MAX_TWEET_LENGTH} characters (got ${trimmed.length}). Shorten the text.` };
  }
  return { valid: true, text: trimmed };
}
async function postTweet(credentials, text) {
  const validation = validateTweetText(text);
  if (!validation.valid) return { ok: false, error: validation.error };
  const result = await xApiFetch("POST", "/tweets", credentials, {
    body: { text: validation.text }
  });
  if (result.ok && result.data?.data?.id) {
    const tweetId = result.data.data.id;
    const username = credentials.username || "unknown";
    return {
      ok: true,
      tweetId,
      tweetUrl: `https://x.com/${username}/status/${tweetId}`,
      text: validation.text
    };
  }
  return result;
}
async function replyToTweet(credentials, tweetId, text) {
  const validation = validateTweetText(text);
  if (!validation.valid) return { ok: false, error: validation.error };
  if (!tweetId || typeof tweetId !== "string") {
    return { ok: false, error: "tweetId is required to reply." };
  }
  const result = await xApiFetch("POST", "/tweets", credentials, {
    body: {
      text: validation.text,
      reply: { in_reply_to_tweet_id: tweetId }
    }
  });
  if (result.ok && result.data?.data?.id) {
    const replyId = result.data.data.id;
    const username = credentials.username || "unknown";
    return {
      ok: true,
      replyId,
      replyUrl: `https://x.com/${username}/status/${replyId}`,
      inReplyTo: tweetId,
      text: validation.text
    };
  }
  return result;
}
async function readMentions(credentials, { maxResults = 10, sinceId = null, paginationToken = null } = {}) {
  if (!credentials.userId) {
    return { ok: false, error: "userId is required to read mentions. Set it in the agent's X profile config." };
  }
  const queryParams = {
    max_results: String(Math.min(Math.max(maxResults, 5), 100)),
    "tweet.fields": "created_at,author_id,conversation_id,in_reply_to_user_id,text",
    expansions: "author_id",
    "user.fields": "username,name"
  };
  if (sinceId) queryParams.since_id = sinceId;
  if (paginationToken) queryParams.pagination_token = paginationToken;
  const result = await xApiFetch("GET", `/users/${credentials.userId}/mentions`, credentials, { queryParams });
  if (result.ok) {
    const tweets = result.data?.data || [];
    const users = result.data?.includes?.users || [];
    const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
    return {
      ok: true,
      mentions: tweets.map((t) => ({
        id: t.id,
        text: t.text,
        authorId: t.author_id,
        authorUsername: userMap[t.author_id]?.username || "unknown",
        authorName: userMap[t.author_id]?.name || "unknown",
        createdAt: t.created_at,
        conversationId: t.conversation_id
      })),
      nextToken: result.data?.meta?.next_token || null,
      resultCount: result.data?.meta?.result_count || 0
    };
  }
  return result;
}
async function searchTweets(credentials, query, { maxResults = 10, sinceId = null, paginationToken = null } = {}) {
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return { ok: false, error: "Search query is required." };
  }
  const queryParams = {
    query: query.trim(),
    max_results: String(Math.min(Math.max(maxResults, 10), 100)),
    "tweet.fields": "created_at,author_id,public_metrics,conversation_id,text",
    expansions: "author_id",
    "user.fields": "username,name,public_metrics"
  };
  if (sinceId) queryParams.since_id = sinceId;
  if (paginationToken) queryParams.next_token = paginationToken;
  const result = await xApiFetch("GET", "/tweets/search/recent", credentials, { queryParams });
  if (result.ok) {
    const tweets = result.data?.data || [];
    const users = result.data?.includes?.users || [];
    const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
    return {
      ok: true,
      tweets: tweets.map((t) => ({
        id: t.id,
        text: t.text,
        authorId: t.author_id,
        authorUsername: userMap[t.author_id]?.username || "unknown",
        authorName: userMap[t.author_id]?.name || "unknown",
        createdAt: t.created_at,
        metrics: t.public_metrics || {},
        conversationId: t.conversation_id
      })),
      nextToken: result.data?.meta?.next_token || null,
      resultCount: result.data?.meta?.result_count || 0
    };
  }
  return result;
}
async function getThread(credentials, tweetId, { maxResults = 20 } = {}) {
  if (!tweetId || typeof tweetId !== "string") {
    return { ok: false, error: "tweetId is required to get a thread." };
  }
  const queryParams = {
    query: `conversation_id:${tweetId}`,
    max_results: String(Math.min(Math.max(maxResults, 10), 100)),
    "tweet.fields": "created_at,author_id,in_reply_to_user_id,conversation_id,text,public_metrics",
    expansions: "author_id",
    "user.fields": "username,name"
  };
  const result = await xApiFetch("GET", "/tweets/search/recent", credentials, { queryParams });
  if (result.ok) {
    const tweets = result.data?.data || [];
    const users = result.data?.includes?.users || [];
    const userMap = Object.fromEntries(users.map((u) => [u.id, u]));
    return {
      ok: true,
      conversationId: tweetId,
      replies: tweets.map((t) => ({
        id: t.id,
        text: t.text,
        authorId: t.author_id,
        authorUsername: userMap[t.author_id]?.username || "unknown",
        createdAt: t.created_at,
        metrics: t.public_metrics || {}
      })),
      resultCount: tweets.length
    };
  }
  return result;
}

// lib/x-tools.mjs
function parseXConfig(obj) {
  const xRaw = obj?.x && typeof obj.x === "object" && !Array.isArray(obj.x) ? obj.x : {};
  const consumerKey = typeof xRaw.consumerKey === "string" ? xRaw.consumerKey : process.env.X_CONSUMER_KEY || "";
  const consumerSecret = typeof xRaw.consumerSecret === "string" ? xRaw.consumerSecret : process.env.X_CONSUMER_SECRET || "";
  const profiles = {};
  if (xRaw.profiles && typeof xRaw.profiles === "object" && !Array.isArray(xRaw.profiles)) {
    for (const [key, val] of Object.entries(xRaw.profiles)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const envPrefix2 = `X_ACCESS_TOKEN_${key.toUpperCase().replace(/-/g, "_")}`;
        const accessToken = typeof val.accessToken === "string" ? val.accessToken : process.env[envPrefix2] || "";
        const accessTokenSecret = typeof val.accessTokenSecret === "string" ? val.accessTokenSecret : process.env[`${envPrefix2}_SECRET`] || "";
        if (accessToken && accessTokenSecret) {
          profiles[key] = {
            accessToken,
            accessTokenSecret,
            userId: typeof val.userId === "string" ? val.userId : void 0,
            username: typeof val.username === "string" ? val.username : void 0
          };
        }
      }
    }
  }
  const defaultAgentId = typeof obj?.agentId === "string" ? obj.agentId : "main";
  const envPrefix = `X_ACCESS_TOKEN_${defaultAgentId.toUpperCase().replace(/-/g, "_")}`;
  const envAccessToken = process.env[envPrefix] || "";
  const envAccessTokenSecret = process.env[`${envPrefix}_SECRET`] || "";
  if (!profiles[defaultAgentId] && envAccessToken && envAccessTokenSecret) {
    profiles[defaultAgentId] = { accessToken: envAccessToken, accessTokenSecret: envAccessTokenSecret };
  }
  if (consumerKey && consumerSecret) {
    return { ok: true, consumerKey, consumerSecret, profiles };
  }
  return { ok: false, consumerKey: "", consumerSecret: "", profiles: {} };
}
function resolveAgentCredentials(xConfig, callerAgentId, requestedAgentId, fallbackAgentId) {
  const agentId = callerAgentId || requestedAgentId || fallbackAgentId || "main";
  if (!xConfig || !xConfig.ok) {
    return { ok: false, error: "X/Twitter configuration missing. Set 'x.consumerKey', 'x.consumerSecret', and 'x.profiles.<agentId>' in plugin config, or use X_CONSUMER_KEY / X_CONSUMER_SECRET env vars." };
  }
  const profile = xConfig.profiles[agentId];
  if (!profile) {
    return { ok: false, error: `No X profile configured for agent '${agentId}'. Available profiles: ${Object.keys(xConfig.profiles).join(", ") || "none"}` };
  }
  return {
    ok: true,
    agentId,
    credentials: {
      consumerKey: xConfig.consumerKey,
      consumerSecret: xConfig.consumerSecret,
      accessToken: profile.accessToken,
      accessTokenSecret: profile.accessTokenSecret,
      userId: profile.userId || null,
      username: profile.username || agentId
    }
  };
}
function registerXReadTools(api, Type2, xConfig, fallbackAgentId, logPrefix, options) {
  const checkPermission = options?.checkPermission || null;
  const json = (data) => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
  });
  const wrapExecute = (toolName, fn) => async (toolCallId, params) => {
    try {
      if (checkPermission) {
        const callingAgentId = params?._agentId || fallbackAgentId;
        const permError = checkPermission(toolName, callingAgentId);
        if (permError) {
          return json({ error: permError, tool: toolName, agentId: callingAgentId });
        }
      }
      const result = await fn(toolCallId, params ?? {});
      return json(result);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  api.registerTool({
    name: "x_search_tweets",
    description: "Search recent tweets on X/Twitter by keyword, hashtag, cashtag, or advanced query. Use for social research: token sentiment, narrative detection, influencer monitoring, KOL tracking. Requires pay-as-you-go or Basic tier X API access.",
    parameters: Type2.Object({
      query: Type2.String({ description: "Search query. Examples: '$BONK sentiment', 'solana memecoin', 'from:elonmusk crypto', '#SOL', 'conversation_id:123'" }),
      maxResults: Type2.Optional(Type2.Number({ description: "Number of results (10-100, default: 10)" })),
      sinceId: Type2.Optional(Type2.String({ description: "Only return tweets newer than this tweet ID" })),
      paginationToken: Type2.Optional(Type2.String({ description: "Pagination token from a previous response" })),
      agentId: Type2.Optional(Type2.String({ description: "Override agent ID (default: caller's agent identity)" }))
    }),
    execute: wrapExecute("x_search_tweets", async (_id, params) => {
      const callerAgentId = params._agentId;
      const creds = resolveAgentCredentials(xConfig, callerAgentId, params.agentId, fallbackAgentId);
      if (!creds.ok) return { error: creds.error };
      return searchTweets(creds.credentials, params.query, {
        maxResults: params.maxResults,
        sinceId: params.sinceId,
        paginationToken: params.paginationToken
      });
    })
  });
  api.registerTool({
    name: "x_read_mentions",
    description: "Read recent @mentions of the configured X profile. Use for monitoring community reactions and engagement. Requires pay-as-you-go or Basic tier X API access.",
    parameters: Type2.Object({
      maxResults: Type2.Optional(Type2.Number({ description: "Number of mentions to return (5-100, default: 10)" })),
      sinceId: Type2.Optional(Type2.String({ description: "Only return mentions newer than this tweet ID" })),
      paginationToken: Type2.Optional(Type2.String({ description: "Pagination token from a previous response" })),
      agentId: Type2.Optional(Type2.String({ description: "Override agent ID (default: caller's agent identity)" }))
    }),
    execute: wrapExecute("x_read_mentions", async (_id, params) => {
      const callerAgentId = params._agentId;
      const creds = resolveAgentCredentials(xConfig, callerAgentId, params.agentId, fallbackAgentId);
      if (!creds.ok) return { error: creds.error };
      return readMentions(creds.credentials, {
        maxResults: params.maxResults,
        sinceId: params.sinceId,
        paginationToken: params.paginationToken
      });
    })
  });
  api.registerTool({
    name: "x_get_thread",
    description: "Read a full conversation thread on X/Twitter by tweet ID. Use for understanding context around viral posts or influencer discussions. Requires pay-as-you-go or Basic tier X API access.",
    parameters: Type2.Object({
      tweetId: Type2.String({ description: "The tweet ID to get the conversation thread for" }),
      maxResults: Type2.Optional(Type2.Number({ description: "Max replies to return (10-100, default: 20)" })),
      agentId: Type2.Optional(Type2.String({ description: "Override agent ID (default: caller's agent identity)" }))
    }),
    execute: wrapExecute("x_get_thread", async (_id, params) => {
      const callerAgentId = params._agentId;
      const creds = resolveAgentCredentials(xConfig, callerAgentId, params.agentId, fallbackAgentId);
      if (!creds.ok) return { error: creds.error };
      return getThread(creds.credentials, params.tweetId, {
        maxResults: params.maxResults
      });
    })
  });
  api.logger.info(`${logPrefix} Registered 3 X/Twitter read tools (search, mentions, threads). Profiles: ${xConfig.ok ? Object.keys(xConfig.profiles).join(", ") || "none" : "unconfigured"}`);
}
function registerXTools(api, Type2, xConfig, fallbackAgentId, logPrefix, options) {
  registerXReadTools(api, Type2, xConfig, fallbackAgentId, logPrefix, options);
  const checkPermission = options?.checkPermission || null;
  const json = (data) => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
  });
  const wrapExecute = (toolName, fn) => async (toolCallId, params) => {
    try {
      if (checkPermission) {
        const callingAgentId = params?._agentId || fallbackAgentId;
        const permError = checkPermission(toolName, callingAgentId);
        if (permError) {
          return json({ error: permError, tool: toolName, agentId: callingAgentId });
        }
      }
      const result = await fn(toolCallId, params ?? {});
      return json(result);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  api.registerTool({
    name: "x_post_tweet",
    description: "Post a new tweet from the configured X profile (max 280 characters). Use for trade journaling, announcements, and community updates. Requires X app with Read + Write and OAuth 1.0a user tokens.",
    parameters: Type2.Object({
      text: Type2.String({ description: "Tweet body (plain text, max 280 chars after trim)" }),
      agentId: Type2.Optional(Type2.String({ description: "Override agent ID (default: caller's agent identity)" }))
    }),
    execute: wrapExecute("x_post_tweet", async (_id, params) => {
      const callerAgentId = params._agentId;
      const creds = resolveAgentCredentials(xConfig, callerAgentId, params.agentId, fallbackAgentId);
      if (!creds.ok) return { error: creds.error };
      return postTweet(creds.credentials, params.text);
    })
  });
  api.registerTool({
    name: "x_reply_tweet",
    description: "Reply to an existing tweet by ID from the configured X profile. Use for threading journal entries or engaging with mentions. Requires Read + Write OAuth 1.0a user tokens.",
    parameters: Type2.Object({
      tweetId: Type2.String({ description: "Target tweet ID to reply to" }),
      text: Type2.String({ description: "Reply body (plain text, max 280 chars after trim)" }),
      agentId: Type2.Optional(Type2.String({ description: "Override agent ID (default: caller's agent identity)" }))
    }),
    execute: wrapExecute("x_reply_tweet", async (_id, params) => {
      const callerAgentId = params._agentId;
      const creds = resolveAgentCredentials(xConfig, callerAgentId, params.agentId, fallbackAgentId);
      if (!creds.ok) return { error: creds.error };
      return replyToTweet(creds.credentials, params.tweetId, params.text);
    })
  });
  api.logger.info(
    `${logPrefix} Registered 5 X/Twitter tools (3 read + post + reply). Profiles: ${xConfig.ok ? Object.keys(xConfig.profiles).join(", ") || "none" : "unconfigured"}`
  );
}

// lib/web-fetch.mjs
import { lookup } from "node:dns/promises";
var BLOCKED_HOSTS = /* @__PURE__ */ new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "metadata.google.internal",
  "169.254.169.254"
]);
var MAX_BODY_BYTES = 512 * 1024;
var FETCH_TIMEOUT_MS = 1e4;
var MAX_OUTPUT_CHARS = 8e3;
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
  const m = html.match(/<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([\s\S]*?)["'][^>]*>/i) || html.match(/<meta[^>]+content\s*=\s*["']([\s\S]*?)["'][^>]+name\s*=\s*["']description["'][^>]*>/i);
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
  const seen = /* @__PURE__ */ new Set();
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
    } catch {
    }
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
async function fetchUrl(url) {
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
        "Accept-Language": "en-US,en;q=0.9"
      },
      redirect: "follow"
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
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
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
        bodyTruncated: jsonStr.length > MAX_OUTPUT_CHARS
      };
    }
    if (isHtml || !isText && !isJson) {
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
        bodyTruncated: stripHtml(raw).length > MAX_OUTPUT_CHARS
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
      bodyTruncated: raw.length > MAX_OUTPUT_CHARS
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      return { ok: false, error: `Request timed out after ${FETCH_TIMEOUT_MS}ms`, url };
    }
    return { ok: false, error: err.message || String(err), url };
  }
}
function registerWebFetchTool(api, Type2, logPrefix, options) {
  const checkPermission = options?.checkPermission || null;
  const json = (data) => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
  });
  api.registerTool({
    name: "web_fetch_url",
    description: "Fetch a URL and return its content as structured text. Extracts title, meta description, headings, social links, outbound links, and body text from HTML pages. Returns raw JSON for JSON responses. Use for analyzing token project websites, metadata URIs, and verifying social link legitimacy. Results should be cached in memory \u2014 do not re-fetch the same URL within 48 hours.",
    parameters: Type2.Object({
      url: Type2.String({ description: "The URL to fetch (must be http:// or https://)" })
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
    }
  });
  api.logger.info(`${logPrefix} Registered web_fetch_url tool (website analysis, metadata URI inspection)`);
}

// index.ts
import * as fs from "fs";
import { homedir } from "os";
import * as path from "path";
function parseConfig(raw) {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const orchestratorUrl = typeof obj.orchestratorUrl === "string" ? obj.orchestratorUrl : "";
  const walletId = typeof obj.walletId === "string" ? obj.walletId : typeof obj.walletId === "number" ? String(obj.walletId) : "";
  const apiKey = typeof obj.apiKey === "string" ? obj.apiKey : "";
  const externalUserId = typeof obj.externalUserId === "string" ? obj.externalUserId : void 0;
  const refreshToken = typeof obj.refreshToken === "string" ? obj.refreshToken : void 0;
  const walletPublicKey = typeof obj.walletPublicKey === "string" ? obj.walletPublicKey : void 0;
  const apiTimeout = typeof obj.apiTimeout === "number" ? obj.apiTimeout : 12e4;
  const agentId = typeof obj.agentId === "string" ? obj.agentId : void 0;
  const gatewayBaseUrl = typeof obj.gatewayBaseUrl === "string" ? obj.gatewayBaseUrl : void 0;
  const gatewayToken = typeof obj.gatewayToken === "string" ? obj.gatewayToken : void 0;
  const dataDir = typeof obj.dataDir === "string" ? obj.dataDir : void 0;
  const xConfig = parseXConfig(obj);
  return {
    orchestratorUrl,
    walletId,
    apiKey,
    externalUserId,
    refreshToken,
    walletPublicKey,
    apiTimeout,
    agentId,
    gatewayBaseUrl,
    gatewayToken,
    dataDir,
    xConfig
  };
}
function buildTraderClawWelcomeMessage(apiKeyForDisplay) {
  const keyBlock = apiKeyForDisplay ? `Your TraderClaw API Key:

${apiKeyForDisplay}

Use this to connect your dashboard.` : `Your API key is not stored in plaintext in this OpenClaw config (session-only or refresh-token flow). On the machine where you ran setup, run \`traderclaw config show\` to view it, or use the TraderClaw dashboard account settings.`;
  return `\u{1F680} TraderClaw is live.

Connection established. The desk is up.

I'm now watching the Solana memecoin market, tracking launches, ingesting alpha signals, and analyzing liquidity, wallets, and sentiment in real time.

Nothing moves without context.
Nothing executes without passing risk.


\u{1F9E0} How I operate

I don't chase noise.

Scan \u2192 analyze \u2192 score \u2192 validate \u2192 execute.
Every trade is structured. Every decision is logged.

And I evolve.

Every outcome feeds back into the system.
Patterns improve. Filters sharpen. Decisions get better over time.


\u{1F511} Access

${keyBlock}


\u2699\uFE0F Get started

1) Fund your wallet
Send SOL to your trading wallet
Ask: what is my wallet address?

2) Choose operating mode
HARDENED \u2192 defensive, selective
DEGEN \u2192 aggressive, faster

3) Give me a name (optional)
Example: Your name is Atlas


\u{1F91D} How we work together

I operate autonomously, scanning, filtering, and acting when conditions make sense.

You can guide or question decisions anytime.
I will not execute trades that do not meet criteria.

Think of this as a trading desk you work with, not a bot you micromanage.


\u26A1 Command Examples (not limited)

\u2022 scan for alpha \u2192 start hunting
\u2022 status \u2192 full system check
\u2022 pause trading \u2192 halt execution


Start simple. Fund \u2192 set mode \u2192 observe.

Let's see what the market gives us.`;
}
var solanaTraderPlugin = {
  id: "solana-trader",
  name: "Solana Trader",
  description: "Autonomous Solana memecoin trading agent \u2014 orchestrator integration",
  register(api) {
    const config = parseConfig(api.pluginConfig);
    const { orchestratorUrl, walletId, apiKey, apiTimeout } = config;
    if (!orchestratorUrl) {
      api.logger.error("[solana-trader] orchestratorUrl is required in plugin config. Run: traderclaw setup");
      return;
    }
    if (!apiKey && !config.refreshToken) {
      api.logger.error(
        "[solana-trader] apiKey or refreshToken is required. Tell the user to run on their machine: traderclaw setup --signup (or traderclaw signup) for a new account, or traderclaw setup / traderclaw login if they already have an API key. The agent cannot sign up or edit credentials."
      );
      return;
    }
    const dataDir = config.dataDir || path.join(process.cwd(), ".traderclaw-v1-data");
    const sessionTokensPath = path.join(dataDir, "session-tokens.json");
    const readSessionSidecar = () => {
      try {
        if (!fs.existsSync(sessionTokensPath)) return null;
        const raw = JSON.parse(fs.readFileSync(sessionTokensPath, "utf-8"));
        if (!raw || typeof raw !== "object") return null;
        return raw;
      } catch {
        return null;
      }
    };
    const writeSessionSidecarAtomic = (payload) => {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${sessionTokensPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf-8");
      fs.renameSync(tmp, sessionTokensPath);
    };
    const sidecar = readSessionSidecar();
    const effectiveRefreshToken = typeof sidecar?.refreshToken === "string" && sidecar.refreshToken.length > 0 ? sidecar.refreshToken : config.refreshToken;
    const effectiveWalletPublicKey = typeof sidecar?.walletPublicKey === "string" && sidecar.walletPublicKey.length > 0 ? sidecar.walletPublicKey : config.walletPublicKey;
    let initialAccessToken;
    let initialAccessTokenExpiresAt;
    if (typeof sidecar?.accessToken === "string" && sidecar.accessToken.length > 0 && typeof sidecar.accessTokenExpiresAt === "number" && Date.now() < sidecar.accessTokenExpiresAt - 5e3) {
      initialAccessToken = sidecar.accessToken;
      initialAccessTokenExpiresAt = sidecar.accessTokenExpiresAt;
    }
    api.logger.info(
      `[solana-trader] Session: sidecar=${sidecar ? "yes" : "no"}, refreshToken=${effectiveRefreshToken ? "present (" + effectiveRefreshToken.slice(0, 8) + "...)" : "MISSING"}, apiKey=${apiKey ? "present" : "MISSING"}, walletPublicKey=${effectiveWalletPublicKey ? "present" : "MISSING"}`
    );
    const sessionManager = new SessionManager({
      baseUrl: orchestratorUrl,
      apiKey: apiKey || "",
      refreshToken: effectiveRefreshToken,
      walletPublicKey: effectiveWalletPublicKey,
      walletPrivateKeyProvider: () => {
        const runtimeKey = process.env.TRADERCLAW_WALLET_PRIVATE_KEY || "";
        return runtimeKey.trim() || void 0;
      },
      clientLabel: "openclaw-plugin-runtime",
      timeout: apiTimeout,
      initialAccessToken,
      initialAccessTokenExpiresAt,
      onTokensRotated: (tokens) => {
        try {
          writeSessionSidecarAtomic({
            refreshToken: tokens.refreshToken,
            accessToken: tokens.accessToken,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            walletPublicKey: tokens.walletPublicKey
          });
          api.logger.info(`[solana-trader] Persisted session tokens to ${sessionTokensPath}`);
        } catch (err) {
          api.logger.warn(
            `[solana-trader] Failed to persist session sidecar: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      },
      logger: {
        info: (msg) => api.logger.info(`[solana-trader] ${msg}`),
        warn: (msg) => api.logger.warn(`[solana-trader] ${msg}`),
        error: (msg) => api.logger.error(`[solana-trader] ${msg}`)
      }
    });
    const onUnauthorized = async () => {
      api.logger.warn("[solana-trader] Received 401 \u2014 refreshing session...");
      return sessionManager.handleUnauthorized();
    };
    const post = async (path2, body, extraHeaders) => {
      const token = await sessionManager.getAccessToken();
      return orchestratorRequest({
        baseUrl: orchestratorUrl,
        method: "POST",
        path: path2,
        body: { walletId, ...body },
        timeout: apiTimeout,
        accessToken: token,
        extraHeaders,
        onUnauthorized
      });
    };
    const get = async (path2) => {
      const token = await sessionManager.getAccessToken();
      return orchestratorRequest({
        baseUrl: orchestratorUrl,
        method: "GET",
        path: path2,
        timeout: apiTimeout,
        accessToken: token,
        onUnauthorized
      });
    };
    const put = async (path2, body) => {
      const token = await sessionManager.getAccessToken();
      return orchestratorRequest({
        baseUrl: orchestratorUrl,
        method: "PUT",
        path: path2,
        body,
        timeout: apiTimeout,
        accessToken: token,
        onUnauthorized
      });
    };
    const del = async (path2) => {
      const token = await sessionManager.getAccessToken();
      return orchestratorRequest({
        baseUrl: orchestratorUrl,
        method: "DELETE",
        path: path2,
        timeout: apiTimeout,
        accessToken: token,
        onUnauthorized
      });
    };
    const json = (data) => ({
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
    });
    const wrapExecute = (fn) => async (toolCallId, params) => {
      try {
        const result = await fn(toolCallId, params ?? {});
        return json(result);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) });
      }
    };
    const stateDir = path.join(dataDir, "state");
    const logsDir = path.join(dataDir, "logs");
    const sharedLogsDir = path.join(logsDir, "shared");
    const workspaceRoot = path.join(homedir(), ".openclaw", "workspace");
    const stateMdPath = path.join(workspaceRoot, "STATE.md");
    const memoryDir = path.join(workspaceRoot, "memory");
    const ensureDir = (dirPath) => {
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    };
    ensureDir(stateDir);
    ensureDir(sharedLogsDir);
    ensureDir(workspaceRoot);
    const readJsonFile = (filePath) => {
      try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {
        return null;
      }
    };
    const deepMerge = (target, source) => {
      const result = { ...target };
      for (const key of Object.keys(source)) {
        const sv = source[key];
        const tv = result[key];
        if (sv && typeof sv === "object" && !Array.isArray(sv) && tv && typeof tv === "object" && !Array.isArray(tv)) {
          result[key] = deepMerge(tv, sv);
        } else {
          result[key] = sv;
        }
      }
      return result;
    };
    const writeJsonFile = (filePath, data) => {
      ensureDir(path.dirname(filePath));
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    };
    const readJsonlFile = (filePath, maxEntries) => {
      try {
        if (!fs.existsSync(filePath)) return [];
        const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
        const entries = lines.map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        }).filter(Boolean);
        return maxEntries ? entries.slice(-maxEntries) : entries;
      } catch {
        return [];
      }
    };
    const appendJsonlFile = (filePath, entry, maxEntries) => {
      ensureDir(path.dirname(filePath));
      let entries = readJsonlFile(filePath);
      entries.push(entry);
      if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
      fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
      return entries.length;
    };
    const generateStateMd = (aid, stateObj) => {
      const lines = [
        `# ${aid} \u2014 Persisted state (STATE.md)`,
        ``,
        `> Auto-generated by solana_state_save. OpenClaw loads workspace files (including STATE.md) into context.`,
        `> Last updated: ${(/* @__PURE__ */ new Date()).toISOString()}`,
        ``
      ];
      if (!stateObj || typeof stateObj !== "object") {
        lines.push("_No state saved yet._");
        return lines.join("\n");
      }
      const state = stateObj;
      const identity = [];
      if (state.tier) identity.push(`- **Tier:** ${state.tier}`);
      if (state.walletId) identity.push(`- **Wallet:** ${state.walletId}`);
      if (state.mode) identity.push(`- **Mode:** ${state.mode}`);
      if (state.strategyVersion) identity.push(`- **Strategy Version:** ${state.strategyVersion}`);
      if (state.regime) identity.push(`- **Regime:** ${state.regime}`);
      if (state.maxPositions) identity.push(`- **Max Positions:** ${state.maxPositions}`);
      if (state.maxPositionSizeSol) identity.push(`- **Max Position Size:** ${state.maxPositionSizeSol} SOL`);
      if (identity.length > 0) {
        lines.push("## Identity & Config", "", ...identity, "");
      }
      if (state.defenseMode !== void 0) lines.push(`## Defense Mode

- **Active:** ${state.defenseMode}
`);
      if (state.killSwitchActive !== void 0) lines.push(`## Kill Switch

- **Active:** ${state.killSwitchActive}
`);
      if (state.watchlist && Array.isArray(state.watchlist) && state.watchlist.length > 0) {
        lines.push("## Watchlist", "");
        for (const item of state.watchlist.slice(0, 20)) {
          lines.push(`- ${typeof item === "string" ? item : JSON.stringify(item)}`);
        }
        lines.push("");
      }
      if (state.permanentLearnings && Array.isArray(state.permanentLearnings)) {
        lines.push("## Permanent Learnings", "");
        for (const learning of state.permanentLearnings.slice(0, 30)) {
          lines.push(`- ${typeof learning === "string" ? learning : JSON.stringify(learning)}`);
        }
        lines.push("");
      }
      if (state.regimeCanary && typeof state.regimeCanary === "object") {
        const rc = state.regimeCanary;
        lines.push("## Regime Canary", "", `- **Regime:** ${rc.regime || "unknown"}`, `- **Detected At:** ${rc.detectedAt || "unknown"}`, "");
      }
      const excludeKeys = /* @__PURE__ */ new Set(["tier", "walletId", "mode", "strategyVersion", "regime", "maxPositions", "maxPositionSizeSol", "defenseMode", "killSwitchActive", "watchlist", "permanentLearnings", "regimeCanary"]);
      const otherKeys = Object.keys(state).filter((k) => !excludeKeys.has(k));
      if (otherKeys.length > 0) {
        lines.push("## Other State Keys", "");
        for (const key of otherKeys.slice(0, 30)) {
          const val = state[key];
          const display = typeof val === "object" ? JSON.stringify(val) : String(val);
          lines.push(`- **${key}:** ${display.length > 200 ? display.slice(0, 200) + "\u2026" : display}`);
        }
        lines.push("");
      }
      return lines.join("\n");
    };
    const writeStateMd = (aid, stateObj) => {
      try {
        ensureDir(workspaceRoot);
        const content = generateStateMd(aid, stateObj);
        fs.writeFileSync(stateMdPath, content, "utf-8");
      } catch {
      }
    };
    const getDailyLogPath = (date) => {
      const d = date || /* @__PURE__ */ new Date();
      const dateStr = d.toISOString().slice(0, 10);
      return path.join(memoryDir, `${dateStr}.md`);
    };
    const pruneDailyLogs = (retentionDays = 7) => {
      try {
        if (!fs.existsSync(memoryDir)) return;
        const cutoff = /* @__PURE__ */ new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        const files = fs.readdirSync(memoryDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
        for (const file of files) {
          const dateStr = file.replace(".md", "");
          if (new Date(dateStr) < cutoff) {
            try {
              fs.unlinkSync(path.join(memoryDir, file));
            } catch {
            }
          }
        }
      } catch {
      }
    };
    const agentId = config.agentId || "main";
    const sanitizeAgentId = (id) => {
      const clean = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
      if (!clean) return agentId;
      return clean;
    };
    api.registerTool({
      name: "solana_scan_launches",
      description: "Scan for new Solana token launches (Pump.fun, Raydium, PumpSwap). Returns recent launches with initial metrics. Watch for deployer patterns \u2014 same deployer launching multiple tokens is a serial rugger red flag.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => post("/api/scan/new-launches", {}))
    });
    api.registerTool({
      name: "solana_scan_hot_pairs",
      description: "Find Solana trading pairs with high volume and price acceleration. Returns hot pairs ranked by activity.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => post("/api/scan/hot-pairs", {}))
    });
    api.registerTool({
      name: "solana_market_regime",
      description: "Get the current Solana market regime (bullish/bearish/neutral) with aggregate metrics like total DEX volume and trending sectors.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => post("/api/market/regime", {}))
    });
    api.registerTool({
      name: "solana_token_snapshot",
      description: "Get a price/volume snapshot for a Solana token including current price, 24h OHLC, volume, and trade count.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" })
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/token/snapshot", { tokenAddress: params.tokenAddress })
      )
    });
    api.registerTool({
      name: "solana_token_holders",
      description: "Get holder distribution for a Solana token \u2014 top 10 concentration, dev holdings percentage, total holder count.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" })
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/token/holders", { tokenAddress: params.tokenAddress })
      )
    });
    api.registerTool({
      name: "solana_token_flows",
      description: "Get buy/sell flow data for a Solana token \u2014 pressure ratio, net flow, unique trader count.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" })
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/token/flows", { tokenAddress: params.tokenAddress })
      )
    });
    api.registerTool({
      name: "solana_token_liquidity",
      description: "Get liquidity profile for a Solana token \u2014 pool depth in USD, locked liquidity percentage, DEX breakdown.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" })
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/token/liquidity", { tokenAddress: params.tokenAddress })
      )
    });
    api.registerTool({
      name: "solana_token_risk",
      description: "Get composite risk assessment for a Solana token \u2014 checks mint authority, freeze authority, LP lock/burn status, deployer history, concentration, dev holdings, and honeypot indicators. Hard-skip tokens with active mint or freeze authority.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" })
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/token/risk", { tokenAddress: params.tokenAddress })
      )
    });
    api.registerTool({
      name: "solana_build_thesis",
      description: "Build a complete thesis package for a token \u2014 assembles market data, your strategy weights, your prior trades on this token, journal stats, wallet context, and an advisory risk pre-screen. This is your full intelligence briefing before making a trade decision.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" }),
        maxSizeSol: Type.Optional(Type.Number({ description: "Advisory \u2014 max position size in SOL for risk pre-screen. Not in server schema; accepted but currently ignored." }))
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/thesis/build", {
          tokenAddress: params.tokenAddress,
          maxSizeSol: params.maxSizeSol
        })
      )
    });
    api.registerTool({
      name: "solana_trade_precheck",
      description: "Pre-trade risk check \u2014 validates a proposed trade against risk rules, kill switch, entitlement limits, and on-chain conditions. Returns approved/denied with reasons and capped size. Always call this before executing a trade. Buy: sizeSol required; do not send sizeTokens or sellPct. Sell: send exactly one of sizeTokens or sellPct (not sizeSol). If both sellPct and sizeTokens are sent, sellPct is preferred and sizeTokens is ignored. Optional exit fields (trailingStopPct, trailingStop) are accepted to mirror execute payloads; sizing logic ignores them.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" }),
        side: Type.Union([Type.Literal("buy"), Type.Literal("sell")], { description: "Trade direction" }),
        sizeSol: Type.Optional(Type.Number({ description: "Position size in SOL \u2014 required for buy, omit for sell" })),
        sellPct: Type.Optional(Type.Number({ description: "Sell percentage 1\u2013100 (100 = full exit) \u2014 sell only; preferred over sizeTokens if both sent" })),
        sizeTokens: Type.Optional(Type.Number({ description: "Token amount to sell \u2014 sell only; ignored if sellPct is also provided" })),
        slippageBps: Type.Optional(Type.Number({ description: "Slippage tolerance in basis points (e.g., 300 = 3%)" })),
        trailingStopPct: Type.Optional(Type.Number({ description: "Optional \u2014 same as execute; ignored for policy sizing" })),
        trailingStop: Type.Optional(
          Type.Object({
            levels: Type.Array(
              Type.Object({
                percentage: Type.Number({ description: "Trailing drawdown % from the armed high once the level is active" }),
                amount: Type.Optional(Type.Number({ description: "% of position to sell at this level (1\u2013100). Server default 100." })),
                triggerAboveATH: Type.Optional(
                  Type.Number({
                    description: "Optional. % above session ATH before this level arms. If omitted, API defaults to 100 (2\xD7 ATH)."
                  })
                )
              }),
              { minItems: 1, maxItems: 5, description: "Multi-level trailing (optional on precheck)" }
            )
          })
        )
      }),
      execute: wrapExecute(async (_id, params) => {
        const body = {
          tokenAddress: params.tokenAddress,
          side: params.side,
          slippageBps: params.slippageBps
        };
        if (params.trailingStopPct !== void 0) {
          body.trailingStopPct = params.trailingStopPct;
        }
        const ts = params.trailingStop;
        if (ts?.levels && Array.isArray(ts.levels) && ts.levels.length > 0) {
          body.trailingStop = ts;
        }
        if (params.side === "buy") {
          body.sizeSol = params.sizeSol;
        } else {
          if (params.sellPct !== void 0) {
            body.sellPct = params.sellPct;
          } else if (params.sizeTokens !== void 0) {
            body.sizeTokens = params.sizeTokens;
          }
        }
        return post("/api/trade/precheck", body);
      })
    });
    api.registerTool({
      name: "solana_trade_execute",
      description: "Execute a trade on Solana via the SpyFly bot. Enforces risk rules before proxying to on-chain execution. Returns trade ID, position ID, and transaction signature. IMPORTANT: tpLevels alone (e.g. [10, 15]) means EACH level sells 100% of the position at that gain \u2014 use tpExits for partials (e.g. +10% sell 50%, +15% sell 100%). Trailing: use `trailingStopPct` for a single simple trailing %, or `trailingStop.levels` (1\u20135) for multi-level trailing with optional `triggerAboveATH` per level (% above session ATH before that level arms; if omitted, server defaults to 100 i.e. 2\xD7 ATH). When both are sent, `trailingStop` wins. Buy: sizeSol required; do not send sizeTokens or sellPct. Sell: send exactly one of sizeTokens or sellPct (not sizeSol). If both sellPct and sizeTokens are sent, sellPct is preferred and sizeTokens is ignored.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" }),
        side: Type.Union([Type.Literal("buy"), Type.Literal("sell")], { description: "Trade direction" }),
        sizeSol: Type.Optional(Type.Number({ description: "Position size in SOL \u2014 required for buy, omit for sell" })),
        sellPct: Type.Optional(Type.Number({ description: "Sell percentage 1\u2013100 (100 = full exit) \u2014 sell only; preferred over sizeTokens if both sent" })),
        sizeTokens: Type.Optional(Type.Number({ description: "Token amount to sell \u2014 sell only; ignored if sellPct is also provided" })),
        symbol: Type.String({ description: "Token symbol (e.g., BONK, WIF)" }),
        slippageBps: Type.Optional(Type.Number({ description: "Slippage in basis points (default: 300)" })),
        slPct: Type.Optional(Type.Number({ description: "Stop-loss percentage (e.g., 15 = 15% below entry)" })),
        tpLevels: Type.Optional(
          Type.Array(Type.Number(), {
            description: "TP gain % from entry only \u2014 each level defaults to selling 100% of position. Prefer tpExits when you want partial sells."
          })
        ),
        tpExits: Type.Optional(
          Type.Array(
            Type.Object({
              percent: Type.Number({ description: "Take-profit trigger: % gain from entry (e.g. 10 = +10%)" }),
              amountPct: Type.Number({
                description: "% of position to sell at this TP (1\u2013100). Example: [{percent:10,amountPct:50},{percent:15,amountPct:100}]"
              })
            }),
            { description: "Per-level take-profit sizes. Sent to API as tpExits; overrides plain tpLevels for sizing." }
          )
        ),
        slExits: Type.Optional(
          Type.Array(
            Type.Object({
              percent: Type.Number({ description: "Stop-loss trigger: % drawdown from entry" }),
              amountPct: Type.Number({ description: "% of position to close at this SL level (1\u2013100)" })
            }),
            { description: "Multi-level stop-loss with partial exits (optional). Otherwise use slPct for a single full exit." }
          )
        ),
        trailingStopPct: Type.Optional(
          Type.Number({
            description: "Single trailing-stop % (legacy). Ignored if `trailingStop` is provided."
          })
        ),
        trailingStop: Type.Optional(
          Type.Object({
            levels: Type.Array(
              Type.Object({
                percentage: Type.Number({
                  description: "Once armed, sell when price drops this % from the high (trailing drawdown)."
                }),
                amount: Type.Optional(
                  Type.Number({
                    description: "% of position to sell when this level fires (1\u2013100). Server default 100."
                  })
                ),
                triggerAboveATH: Type.Optional(
                  Type.Number({
                    description: "Optional. Session price must reach this % above session ATH before this level arms (e.g. 50 \u2192 1.5\xD7 ATH). If omitted, API defaults to 100 (2\xD7 ATH)."
                  })
                )
              }),
              {
                minItems: 1,
                maxItems: 5,
                description: "Ordered trailing-stop levels (up to 5)."
              }
            )
          })
        ),
        managementMode: Type.Optional(
          Type.Union([Type.Literal("LOCAL_MANAGED"), Type.Literal("SERVER_MANAGED")], {
            description: "Advisory only \u2014 server decides position mode internally. Sent for future compatibility."
          })
        ),
        idempotencyKey: Type.Optional(Type.String({ description: "Unique key to prevent duplicate executions (e.g., UUID). Server uses walletId + key for replay cache." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const headers = {};
        if (params.idempotencyKey) {
          headers["x-idempotency-key"] = String(params.idempotencyKey);
        }
        const body = {
          tokenAddress: params.tokenAddress,
          side: params.side,
          symbol: params.symbol,
          slippageBps: params.slippageBps,
          slPct: params.slPct,
          managementMode: params.managementMode
        };
        const tsExecute = params.trailingStop;
        if (tsExecute?.levels && Array.isArray(tsExecute.levels) && tsExecute.levels.length > 0) {
          body.trailingStop = tsExecute;
        } else if (params.trailingStopPct !== void 0) {
          body.trailingStopPct = params.trailingStopPct;
        }
        if (params.side === "buy") {
          body.sizeSol = params.sizeSol;
        } else {
          if (params.sellPct !== void 0) {
            body.sellPct = params.sellPct;
          } else if (params.sizeTokens !== void 0) {
            body.sizeTokens = params.sizeTokens;
          }
        }
        const tpExits = params.tpExits;
        const slExits = params.slExits;
        if (Array.isArray(tpExits) && tpExits.length > 0) {
          body.tpExits = tpExits;
        }
        if (Array.isArray(params.tpLevels) && params.tpLevels.length > 0) {
          body.tpLevels = params.tpLevels;
        }
        if (Array.isArray(slExits) && slExits.length > 0) {
          body.slExits = slExits;
        }
        return post("/api/trade/execute", body, Object.keys(headers).length > 0 ? headers : void 0);
      })
    });
    api.registerTool({
      name: "solana_trade_review",
      description: "Submit a post-trade review with outcome and notes. Creates a memory entry linked to the trade for future learning. Be honest \u2014 your future strategy evolution depends on accurate reviews.",
      parameters: Type.Object({
        tradeId: Type.Optional(Type.String({ description: "Trade ID (UUID) to review" })),
        tokenAddress: Type.Optional(Type.String({ description: "Token mint address for the reviewed trade" })),
        outcome: Type.Union([Type.Literal("win"), Type.Literal("loss"), Type.Literal("neutral")], {
          description: "Trade outcome"
        }),
        notes: Type.String({ description: "Detailed analysis: what worked, what didn't, key signals, lessons learned" }),
        pnlSol: Type.Optional(Type.Number({ description: "Actual profit/loss in SOL" })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization (e.g., ['momentum_win', 'late_entry'])" })),
        strategyVersion: Type.Optional(Type.String({ description: "Strategy version at time of trade (e.g., 'v1.3.0')" }))
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/trade/review", {
          tradeId: params.tradeId,
          tokenAddress: params.tokenAddress,
          outcome: params.outcome,
          notes: params.notes,
          pnlSol: params.pnlSol,
          tags: params.tags,
          strategyVersion: params.strategyVersion
        })
      )
    });
    api.registerTool({
      name: "solana_memory_write",
      description: "Write a memory entry \u2014 journal observations, market insights, or trading lessons. These memories are searchable and appear in future thesis packages.",
      parameters: Type.Object({
        notes: Type.String({ description: "Observation or lesson to remember" }),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization (e.g., ['momentum', 'risk', 'regime'])" })),
        tokenAddress: Type.Optional(Type.String({ description: "Associate with a specific token" })),
        outcome: Type.Optional(Type.Union([Type.Literal("win"), Type.Literal("loss"), Type.Literal("neutral")], {
          description: "Outcome if trade-related"
        })),
        strategyVersion: Type.Optional(Type.String({ description: "Strategy version at time of writing (e.g., 'v1.3.0')" }))
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/memory/write", {
          notes: params.notes,
          tags: params.tags,
          tokenAddress: params.tokenAddress,
          outcome: params.outcome,
          strategyVersion: params.strategyVersion
        })
      )
    });
    api.registerTool({
      name: "solana_memory_search",
      description: "Search your trading memory by text query. Returns matching journal entries, trade reviews, and observations.",
      parameters: Type.Object({
        query: Type.String({ description: "Search text (e.g., 'high concentration tokens' or 'momentum plays')" }),
        limit: Type.Optional(Type.Number({ description: "Advisory \u2014 max results to return. Not honored by server; storage applies internal cap (~50)." }))
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/memory/search", {
          query: params.query,
          limit: params.limit
        })
      )
    });
    api.registerTool({
      name: "solana_memory_by_token",
      description: "Get all your prior memory entries for a specific token \u2014 past trades, reviews, and observations. MANDATORY: always call this before re-entering any token you've previously traded. Required by risk rules.",
      parameters: Type.Object({
        tokenAddress: Type.String({ description: "Solana token mint address" })
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/memory/by-token", {
          tokenAddress: params.tokenAddress
        })
      )
    });
    api.registerTool({
      name: "solana_journal_summary",
      description: "Get a summary of your trading journal \u2014 win rate, total entries, recent notes, and performance over a time period.",
      parameters: Type.Object({
        days: Type.Optional(Type.Number({ description: "Look back period in days (default: 7)" }))
      }),
      execute: wrapExecute(async (_id, params) => {
        let path2 = `/api/memory/journal-summary?walletId=${walletId}`;
        if (params.days) path2 += `&lookbackDays=${params.days}`;
        return get(path2);
      })
    });
    api.registerTool({
      name: "solana_strategy_state",
      description: "Read your current strategy state \u2014 feature weights and strategy version. These are YOUR learned preferences that evolve over time.",
      parameters: Type.Object({}),
      execute: wrapExecute(
        async () => get(`/api/strategy/state?walletId=${walletId}`)
      )
    });
    api.registerTool({
      name: "solana_strategy_update",
      description: "Update your strategy weights and/or operating mode. Weights reflect which market signals best predict winners. Server enforces guardrails: min 3 features, each weight 0.01\u20130.50, sum 0.95\u20131.05, max \xB10.20 delta per feature, semver format required, version must increment. Always increment strategyVersion.",
      parameters: Type.Object({
        featureWeights: Type.Record(Type.String(), Type.Number(), {
          description: "Feature weight map (e.g., { volume_momentum: 0.25, buy_pressure: 0.20, ... }). Values should sum to ~1.0"
        }),
        strategyVersion: Type.String({ description: "New version string (e.g., 'v1.3.0'). Always increment from current." }),
        mode: Type.Optional(
          Type.Union([Type.Literal("HARDENED"), Type.Literal("DEGEN")], {
            description: "Operating mode. HARDENED = survival-first, DEGEN = high-velocity. Default: HARDENED"
          })
        )
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/strategy/update", {
          featureWeights: params.featureWeights,
          strategyVersion: params.strategyVersion,
          mode: params.mode
        })
      )
    });
    api.registerTool({
      name: "solana_killswitch",
      description: "Toggle the emergency kill switch. When enabled, ALL trade execution is blocked. Use in emergencies: repeated losses, unusual market behavior, or security concerns.",
      parameters: Type.Object({
        enabled: Type.Boolean({ description: "true to activate (block all trades), false to deactivate" }),
        mode: Type.Optional(
          Type.Union([Type.Literal("TRADES_ONLY"), Type.Literal("TRADES_AND_STREAMS")], {
            description: "TRADES_ONLY blocks execution; TRADES_AND_STREAMS blocks everything"
          })
        )
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/killswitch", {
          enabled: params.enabled,
          mode: params.mode
        })
      )
    });
    api.registerTool({
      name: "solana_killswitch_status",
      description: "Check the current kill switch state \u2014 whether it's enabled and in what mode.",
      parameters: Type.Object({}),
      execute: wrapExecute(
        async () => get(`/api/killswitch/status?walletId=${walletId}`)
      )
    });
    api.registerTool({
      name: "solana_capital_status",
      description: "Get your current capital status \u2014 SOL balance, open position count, unrealized PnL, daily notional used, daily loss, and effective limits (adjusted by entitlements).",
      parameters: Type.Object({}),
      execute: wrapExecute(
        async () => get(`/api/capital/status?walletId=${walletId}`)
      )
    });
    api.registerTool({
      name: "solana_positions",
      description: "List your current trading positions with unrealized PnL, entry price, current price, stop-loss/take-profit settings, and management mode. Call at the START of every trading cycle for interrupt check. Also use to detect dead money (flat positions).",
      parameters: Type.Object({
        status: Type.Optional(Type.String({ description: "Filter by status: 'open', 'closed', or omit for all" }))
      }),
      execute: wrapExecute(async (_id, params) => {
        let path2 = `/api/wallet/positions?walletId=${walletId}`;
        if (params.status) path2 += `&status=${params.status}`;
        return get(path2);
      })
    });
    api.registerTool({
      name: "solana_funding_instructions",
      description: "Get deposit instructions for funding your trading wallet with SOL.",
      parameters: Type.Object({}),
      execute: wrapExecute(
        async () => get(`/api/funding/instructions?walletId=${walletId}`)
      )
    });
    api.registerTool({
      name: "solana_wallets",
      description: "List all wallets associated with your account. Optionally refresh balances from on-chain.",
      parameters: Type.Object({
        refresh: Type.Optional(Type.Boolean({ description: "If true, refresh balances from on-chain before returning" }))
      }),
      execute: wrapExecute(async (_id, params) => {
        let path2 = "/api/wallets";
        if (params.refresh) path2 += "?refresh=true";
        return get(path2);
      })
    });
    api.registerTool({
      name: "solana_wallet_create",
      description: "Create a new trading wallet. Returns the wallet ID and public key. Use this to provision additional wallets for strategy isolation or multi-wallet trading.",
      parameters: Type.Object({
        label: Type.Optional(Type.String({ description: "Human-readable label for the wallet (e.g., 'Degen Wallet')" })),
        publicKey: Type.Optional(Type.String({ description: "Existing Solana public key to import (omit to generate new)" })),
        chain: Type.Optional(Type.Union([Type.Literal("solana"), Type.Literal("bsc")], { description: "Blockchain (default: solana)" })),
        ownerRef: Type.Optional(Type.String({ description: "Owner reference string" })),
        includePrivateKey: Type.Optional(Type.Boolean({ description: "If true, return the private key in the response (only for newly generated wallets)" }))
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/wallet/create", {
          label: params.label,
          publicKey: params.publicKey,
          chain: params.chain,
          ownerRef: params.ownerRef,
          includePrivateKey: params.includePrivateKey
        })
      )
    });
    api.registerTool({
      name: "solana_trades",
      description: "List your trade history with pagination. Returns executed trades with details like token, side, size, PnL, and timestamp.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max trades to return (1-200, default: 50)" })),
        offset: Type.Optional(Type.Number({ description: "Offset for pagination (default: 0)" }))
      }),
      execute: wrapExecute(async (_id, params) => {
        let path2 = `/api/trades?walletId=${walletId}`;
        if (params.limit) path2 += `&limit=${params.limit}`;
        if (params.offset) path2 += `&offset=${params.offset}`;
        return get(path2);
      })
    });
    api.registerTool({
      name: "solana_risk_denials",
      description: "List recent risk denials \u2014 trades that were blocked by the policy engine. Review these to understand what setups trigger denials and avoid repeating wasted analysis.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max denials to return (1-200, default: 50)" }))
      }),
      execute: wrapExecute(async (_id, params) => {
        let path2 = `/api/risk-denials?walletId=${walletId}`;
        if (params.limit) path2 += `&limit=${params.limit}`;
        return get(path2);
      })
    });
    api.registerTool({
      name: "solana_entitlement_costs",
      description: "Get tier costs \u2014 what each tier (starter, pro, enterprise) costs and what capabilities it unlocks.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => get("/api/entitlements/costs"))
    });
    api.registerTool({
      name: "solana_entitlement_plans",
      description: "List available monthly entitlement plans that upgrade your trading limits (position size, daily notional, bandwidth). Shows price, duration, and limit boosts.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => get("/api/entitlements/plans"))
    });
    api.registerTool({
      name: "solana_entitlement_current",
      description: "Get your current entitlements \u2014 active tier, scope access, effective limits, and expiration details.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => {
        const result = await get(`/api/entitlements/current?walletId=${walletId}`);
        if (result && typeof result === "object") {
          try {
            const cacheFile = path.join(stateDir, "entitlement-cache.json");
            writeJsonFile(cacheFile, { ...result, cachedAt: (/* @__PURE__ */ new Date()).toISOString() });
          } catch (_) {
          }
        }
        return result;
      })
    });
    api.registerTool({
      name: "solana_entitlement_purchase",
      description: "Purchase an entitlement plan to upgrade your trading limits. Deducts SOL from your wallet balance. Subject to spend guardrails (daily max, per-upgrade max, cooldown).",
      parameters: Type.Object({
        planCode: Type.String({ description: "Plan code to purchase (e.g., 'pro_trader', 'bandwidth_boost')" })
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/entitlements/purchase", {
          planCode: params.planCode
        })
      )
    });
    api.registerTool({
      name: "solana_entitlement_upgrade",
      description: "Upgrade your account tier (starter \u2192 pro \u2192 enterprise). Unlocks additional endpoints and capabilities. Pro tier is required for scanning, token analysis, and Bitquery tools.",
      parameters: Type.Object({
        targetTier: Type.Union([Type.Literal("starter"), Type.Literal("pro"), Type.Literal("enterprise")], {
          description: "Target tier to upgrade to"
        })
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/entitlements/upgrade", {
          targetTier: params.targetTier
        })
      )
    });
    api.registerTool({
      name: "solana_bitquery_templates",
      description: "List all available pre-built Bitquery query templates with descriptions and required variables. Call this first to discover what templates are available before using solana_bitquery_catalog. Returns 50+ templates organized by category covering Pump.fun, PumpSwap, Raydium, Jupiter, BonkSwap, and generic DEX analytics.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => ({
        categories: {
          pumpFunCreation: [
            { path: "pumpFunCreation.trackNewTokens", description: "Track newly created Pump.fun tokens", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "pumpFunCreation.getCreationTimeAndDev", description: "Get creation time and dev address for token", variables: { token: "String!" } },
            { path: "pumpFunCreation.trackLaunchesRealtime", description: "Track new token launches in real-time via query polling", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "pumpFunCreation.getTokensByCreatorAddress", description: "Get all Pump.fun tokens created by creator wallet", variables: { creator: "String!", limit: "Int!" } },
            { path: "pumpFunCreation.getTokensByCreatorHistorical", description: "Historical token creations by wallet", variables: { creator: "String!", since: "DateTime!", till: "DateTime!" } }
          ],
          pumpFunMetadata: [
            { path: "pumpFunMetadata.tokenMetadataByAddress", description: "Get token metadata plus dev and creation time", variables: { token: "String!" } },
            { path: "pumpFunMetadata.trackMayhemModeRealtime", description: "Track Mayhem Mode enabled tokens in real-time", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "pumpFunMetadata.currentMayhemModeStatus", description: "Check current Mayhem mode status for token", variables: { token: "String!" } },
            { path: "pumpFunMetadata.historicalMayhemModeStatus", description: "Historical mayhem mode changes for token", variables: { token: "String!", since: "DateTime!", till: "DateTime!" } },
            { path: "pumpFunMetadata.latestPrice", description: "Latest price for Pump.fun token", variables: { token: "String!" } }
          ],
          pumpFunPriceMomentum: [
            { path: "pumpFunPriceMomentum.streamTokenPrice", description: "Price stream query for polling mode", variables: { token: "String!", since: "DateTime!" } },
            { path: "pumpFunPriceMomentum.top10PriceChange5m", description: "Top 10 by short-term price change", variables: { since: "DateTime!" } },
            { path: "pumpFunPriceMomentum.tokenOHLC", description: "OHLC data for Pump.fun token", variables: { token: "String!", since: "DateTime!" } },
            { path: "pumpFunPriceMomentum.athMarketCapWindow", description: "ATH market cap in window", variables: { token: "String!", since: "DateTime!", till: "DateTime!" } },
            { path: "pumpFunPriceMomentum.priceChangeDeltaFromMinutesAgo", description: "Price-change delta from X minutes back", variables: { token: "String!", since: "DateTime!" } }
          ],
          pumpFunTradesLiquidity: [
            { path: "pumpFunTradesLiquidity.realtimeTrades", description: "Get real-time trades on Pump.fun", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "pumpFunTradesLiquidity.latestTradesByToken", description: "Latest trades by token", variables: { token: "String!", limit: "Int!" } },
            { path: "pumpFunTradesLiquidity.tradingVolume", description: "Get trading volume for token", variables: { token: "String!", since: "DateTime!" } },
            { path: "pumpFunTradesLiquidity.detailedTradeStats", description: "Detailed trade stats (volume/buys/sells/makers/buyers/sellers)", variables: { token: "String!", since: "DateTime!" } },
            { path: "pumpFunTradesLiquidity.lastTradeBeforeMigration", description: "Last Pump.fun trade before migration to PumpSwap", variables: { token: "String!" } }
          ],
          pumpFunHoldersRisk: [
            { path: "pumpFunHoldersRisk.first100Buyers", description: "Get first 100 buyers", variables: { token: "String!" } },
            { path: "pumpFunHoldersRisk.first100StillHolding", description: "Check whether first 100 buyers still hold", variables: { holders: "[String!]", token: "String!" } },
            { path: "pumpFunHoldersRisk.devHoldings", description: "Get developer holdings for token", variables: { devWallet: "String!", token: "String!" } },
            { path: "pumpFunHoldersRisk.topHoldersTopTradersTopCreators", description: "Get top holders/top traders/top creators", variables: { token: "String!", since: "DateTime!" } },
            { path: "pumpFunHoldersRisk.phishyAndMarketCapFilters", description: "Phishy check + market cap filter scaffolding", variables: { since: "DateTime!", minCap: "String!", maxCap: "String!" } }
          ],
          pumpSwapPostMigration: [
            { path: "pumpSwapPostMigration.newPoolsRealtime", description: "Get newly created PumpSwap pools", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "pumpSwapPostMigration.trackMigratedPools", description: "Track pools migrated to PumpSwap", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "pumpSwapPostMigration.latestTrades", description: "Get latest trades on PumpSwap", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "pumpSwapPostMigration.latestTradesByToken", description: "Latest PumpSwap trades for token", variables: { token: "String!", limit: "Int!" } },
            { path: "pumpSwapPostMigration.pumpSwapSubscriptionScaffold", description: "Query mirror for PumpSwap realtime subscription", variables: { since: "DateTime!" } }
          ],
          pumpSwapPriceTrader: [
            { path: "pumpSwapPriceTrader.trackTokenPriceRealtime", description: "Track PumpSwap token price realtime", variables: { token: "String!", since: "DateTime!" } },
            { path: "pumpSwapPriceTrader.latestPrice", description: "Get latest price for PumpSwap token", variables: { token: "String!" } },
            { path: "pumpSwapPriceTrader.ohlc", description: "OHLC for PumpSwap token", variables: { token: "String!", since: "DateTime!" } },
            { path: "pumpSwapPriceTrader.latestTradesByTrader", description: "Get latest trades by trader", variables: { wallet: "String!", since: "DateTime!" } },
            { path: "pumpSwapPriceTrader.topTradersAndStats", description: "Top traders and token trade stats", variables: { token: "String!", since: "DateTime!" } }
          ],
          launchpadsRaydiumLetsBonk: [
            { path: "launchpadsRaydiumLetsBonk.latestRaydiumLaunchpadPools", description: "Track latest pools created on Raydium Launchpad", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "launchpadsRaydiumLetsBonk.trackMigrationsToRaydium", description: "Track migrations to Raydium DEX/CPMM across launchpads", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "launchpadsRaydiumLetsBonk.bondingCurveProgress", description: "Compute bonding curve progress from latest pool/liquidity snapshot", variables: { token: "String!", since: "DateTime!" } },
            { path: "launchpadsRaydiumLetsBonk.tokensAbove95Progress", description: "Track launchpad tokens above 95% bonding curve progress", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "launchpadsRaydiumLetsBonk.top100AboutToGraduate", description: "Top 100 launchpad tokens near migration", variables: { since: "DateTime!" } }
          ],
          launchpadsTokenLevel: [
            { path: "launchpadsTokenLevel.latestLaunchpadTrades", description: "Get latest launchpad trades", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "launchpadsTokenLevel.latestPriceForToken", description: "Get latest price for launchpad token", variables: { token: "String!" } },
            { path: "launchpadsTokenLevel.latestTradesByUser", description: "Get latest trades by user", variables: { wallet: "String!", since: "DateTime!" } },
            { path: "launchpadsTokenLevel.topBuyersAndSellers", description: "Get top buyers and top sellers for token", variables: { token: "String!", since: "DateTime!" } },
            { path: "launchpadsTokenLevel.ohlcPairAndLiquidity", description: "Get OHLC, pair address and latest liquidity", variables: { token: "String!", since: "DateTime!" } }
          ],
          exchangeSpecific: [
            { path: "exchangeSpecific.raydiumSuite", description: "Raydium: pools, pair create time, latest price, trades, LP changes, OHLC", variables: { token: "String!", since: "DateTime!" } },
            { path: "exchangeSpecific.bonkSwapSuite", description: "BonkSwap: latest trades, top traders, trader feed, OHLC", variables: { token: "String!", wallet: "String!", since: "DateTime!" } },
            { path: "exchangeSpecific.jupiterSuite", description: "Jupiter swaps and order lifecycle query suite", variables: { since: "DateTime!" } },
            { path: "exchangeSpecific.jupiterStudioSuite", description: "Jupiter Studio token trades, prices, OHLC, launches, migrations", variables: { since: "DateTime!", token: "String" } }
          ],
          genericDexAnalytics: [
            { path: "genericDexAnalytics.latestSolanaTrades", description: "Subscribe/query latest Solana trades", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "genericDexAnalytics.priceVsWsolUsdMultiMarket", description: "Token price vs WSOL/USD and multi-market", variables: { token: "String!", since: "DateTime!" } },
            { path: "genericDexAnalytics.pressureTopsAndDexs", description: "Buy/sell pressure and top-bought/top-sold/pairs/dexs", variables: { since: "DateTime!", limit: "Int!" } },
            { path: "genericDexAnalytics.dexMarketsPairsTokenDetails", description: "DEX markets/pairs/token details", variables: { token: "String!", since: "DateTime!" } },
            { path: "genericDexAnalytics.ohlcHistoryAthTrendSearch", description: "OHLC history, ATH, first-24h, trend, search", variables: { token: "String!", since: "DateTime!" } }
          ]
        },
        subscriptions: [
          { key: "realtimeTokenPricesSolana", description: "Real-time token prices on Solana", variables: { token: "String!" } },
          { key: "ohlc1s", description: "1-second OHLC stream", variables: { token: "String!" } },
          { key: "dexPoolLiquidityChanges", description: "DEXPool liquidity changes stream", variables: { token: "String!" } },
          { key: "pumpFunTokenCreation", description: "Pump.fun token creation stream", variables: {} },
          { key: "pumpFunTrades", description: "Pump.fun trades stream", variables: { token: "String" } },
          { key: "pumpSwapTrades", description: "PumpSwap trades stream", variables: { token: "String" } },
          { key: "raydiumNewPools", description: "Raydium v4/Launchpad/CLMM new pools stream", variables: {} }
        ],
        totalTemplates: 54,
        totalSubscriptions: 7,
        usage: "Use solana_bitquery_catalog with templatePath and variables to run any template. For custom queries, use solana_bitquery_query with raw GraphQL."
      }))
    });
    api.registerTool({
      name: "solana_bitquery_catalog",
      description: "Run a pre-built Bitquery query template from the catalog. Use solana_bitquery_templates first to discover available templates. Templates cover Pump.fun creation/metadata/price/trades/holders, PumpSwap post-migration, launchpad analytics, exchange-specific suites (Raydium/Jupiter/BonkSwap), and generic DEX analytics. See query-catalog.md in the solana-trader skill for the full reference.",
      parameters: Type.Object({
        templatePath: Type.String({ description: "Template path in 'category.key' format (e.g., 'pumpFunHoldersRisk.first100Buyers')" }),
        variables: Type.Object({}, { additionalProperties: true, description: "Variables required by the template (e.g., { token: 'MINT_ADDRESS', since: '2025-01-01T00:00:00Z' })" })
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/bitquery/catalog", {
          templatePath: params.templatePath,
          variables: params.variables || {}
        })
      )
    });
    api.registerTool({
      name: "solana_bitquery_query",
      description: "Run a custom raw GraphQL query against the Bitquery v2 EAP endpoint for Solana on-chain data. Use this when no pre-built template fits your needs. IMPORTANT: Consult bitquery-schema.md in the solana-trader skill before writing queries \u2014 DEXTrades and DEXTradeByTokens have different field shapes and mixing them causes errors. The schema reference includes a decision guide, correct field paths, aggregate keys, and a common error fix map.",
      parameters: Type.Object({
        query: Type.String({ description: "Raw GraphQL query string (query or subscription operation)" }),
        variables: Type.Optional(Type.Object({}, { additionalProperties: true, description: "GraphQL variables (e.g., { token: 'MINT_ADDRESS', since: '2025-01-01T00:00:00Z' })" }))
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/bitquery/query", {
          query: params.query,
          variables: params.variables || {}
        })
      )
    });
    api.registerTool({
      name: "solana_bitquery_subscribe",
      description: "Subscribe to a managed real-time Bitquery data stream. The orchestrator manages the WebSocket connection and broadcasts events. Available templates: realtimeTokenPricesSolana, ohlc1s, dexPoolLiquidityChanges, pumpFunTokenCreation, pumpFunTrades, pumpSwapTrades, raydiumNewPools. Returns a subscriptionId for tracking. Pass agentId to enable event-to-agent forwarding \u2014 orchestrator delivers each event to your Gateway via /v1/responses in addition to normal WS delivery. Subscriptions expire after 24h and emit subscription_expiring/subscription_expired events. See websocket-streaming.md in the solana-trader skill for the full message contract and usage patterns.",
      parameters: Type.Object({
        templateKey: Type.String({ description: "Subscription template key (e.g., 'pumpFunTrades', 'ohlc1s', 'realtimeTokenPricesSolana')" }),
        variables: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Template variables (e.g., { token: 'MINT_ADDRESS' })" })),
        agentId: Type.Optional(Type.String({ description: "Agent ID for event-to-agent forwarding (e.g., 'main'). When set, orchestrator forwards each stream event to your registered Gateway via /v1/responses." })),
        subscriberType: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("client")], { description: "Subscriber type. Inferred as 'agent' when agentId is present. Defaults to 'client'." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const body = {
          templateKey: params.templateKey,
          variables: params.variables || {}
        };
        const effectiveAgentId = params.agentId || config.agentId;
        if (effectiveAgentId) {
          body.agentId = effectiveAgentId;
          body.subscriberType = params.subscriberType || "agent";
        } else if (params.subscriberType) {
          body.subscriberType = params.subscriberType;
        }
        return post("/api/bitquery/subscribe", body);
      })
    });
    api.registerTool({
      name: "solana_bitquery_unsubscribe",
      description: "Unsubscribe from a managed Bitquery data stream. Pass the subscriptionId returned by solana_bitquery_subscribe. Important: always use the server-returned subscriptionId, never generate your own.",
      parameters: Type.Object({
        subscriptionId: Type.String({ description: "Subscription ID returned by solana_bitquery_subscribe (e.g., 'bqs_abc123...')" })
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/bitquery/unsubscribe", {
          subscriptionId: params.subscriptionId
        })
      )
    });
    api.registerTool({
      name: "solana_bitquery_subscriptions",
      description: "List all active Bitquery subscriptions and bridge diagnostics. Returns connected clients, active streams, upstream connection status, and per-stream subscriber counts. Use for monitoring real-time data feed health.",
      parameters: Type.Object({}),
      execute: wrapExecute(
        async () => get("/api/bitquery/subscriptions/active")
      )
    });
    api.registerTool({
      name: "solana_bitquery_subscription_reopen",
      description: "Reopen an expired or expiring Bitquery subscription. Subscriptions have a 24h TTL and emit bitquery_subscription_expiring (30 min warning), bitquery_subscription_expired, and reconnect_required events. Call this to renew before or after expiry. The subscription_cleanup cron job handles this automatically, but manual reopen is available for critical subscriptions. Returns the new subscriptionId.",
      parameters: Type.Object({
        subscriptionId: Type.String({ description: "The expired or expiring subscription ID to reopen (e.g., 'bqs_abc123...')" }),
        walletId: Type.Optional(Type.String({ description: "Wallet ID to reopen the subscription for. Defaults to the plugin's configured walletId." }))
      }),
      execute: wrapExecute(
        async (_id, params) => post("/api/bitquery/subscriptions/reopen", {
          subscriptionId: params.subscriptionId,
          ...params.walletId ? { walletId: params.walletId } : {}
        })
      )
    });
    api.registerTool({
      name: "solana_gateway_credentials_set",
      description: "Register or update your OpenClaw Gateway credentials with the orchestrator. This enables event-to-agent forwarding \u2014 when subscriptions include agentId, the orchestrator delivers each stream event to your Gateway via /v1/responses. Call this once during initial setup (Step 0). The gatewayBaseUrl is your self-hosted OpenClaw Gateway's public URL. The gatewayToken is the Bearer token for authenticating forwarded events.",
      parameters: Type.Object({
        gatewayBaseUrl: Type.String({ description: "Your OpenClaw Gateway's public HTTPS URL (e.g., 'https://gateway.example.com')" }),
        gatewayToken: Type.String({ description: "Bearer token for authenticating forwarded events to your Gateway" }),
        agentId: Type.Optional(Type.String({ description: "Agent ID to associate credentials with (default: 'main'). Omit to store as the default fallback." })),
        active: Type.Optional(Type.Boolean({ description: "Whether forwarding is active (default: true)" }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const body = {
          gatewayBaseUrl: params.gatewayBaseUrl,
          gatewayToken: params.gatewayToken
        };
        if (params.agentId) body.agentId = params.agentId;
        if (params.active !== void 0) body.active = params.active;
        return put("/api/agents/gateway-credentials", body);
      })
    });
    api.registerTool({
      name: "solana_gateway_credentials_get",
      description: "Get the currently registered Gateway credentials for event-to-agent forwarding. Returns the gatewayBaseUrl, agentId, active status, and masked token. Use to verify Gateway setup is correct.",
      parameters: Type.Object({}),
      execute: wrapExecute(
        async () => get("/api/agents/gateway-credentials")
      )
    });
    api.registerTool({
      name: "solana_gateway_credentials_delete",
      description: "Delete your registered Gateway credentials. This disables event-to-agent forwarding \u2014 subscriptions with agentId will no longer forward events to your Gateway. Only use if decommissioning the Gateway.",
      parameters: Type.Object({}),
      execute: wrapExecute(
        async () => del("/api/agents/gateway-credentials")
      )
    });
    api.registerTool({
      name: "solana_agent_sessions",
      description: "List active agent sessions registered with the orchestrator. Returns session IDs, agent IDs, connection status, and subscription counts. Use for diagnostics \u2014 verify your agent is properly registered and its subscriptions are forwarding events.",
      parameters: Type.Object({}),
      execute: wrapExecute(
        async () => get("/api/agents/active")
      )
    });
    const alphaBuffer = new AlphaBuffer();
    const alphaStreamManager = new AlphaStreamManager({
      wsUrl: orchestratorUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws",
      getAccessToken: () => sessionManager.getAccessToken(),
      buffer: alphaBuffer,
      agentId: config.agentId,
      logger: {
        info: (msg) => api.logger.info(`[solana-trader] ${msg}`),
        warn: (msg) => api.logger.warn(`[solana-trader] ${msg}`),
        error: (msg) => api.logger.error(`[solana-trader] ${msg}`)
      }
    });
    let startupGateRunning = null;
    let startupGateState = {
      ok: false,
      ts: 0,
      steps: []
    };
    let lastForwardProbeState = null;
    const getActiveCredential = (payload) => {
      if (!payload || typeof payload !== "object") return null;
      const credentials = payload.credentials;
      if (!Array.isArray(credentials)) return null;
      const preferredAgentId = config.agentId || "main";
      const active = credentials.find(
        (entry) => entry && typeof entry === "object" && Boolean(entry.active) && (entry.agentId || "main") === preferredAgentId
      ) || credentials.find(
        (entry) => entry && typeof entry === "object" && Boolean(entry.active)
      );
      return active && typeof active === "object" ? active : null;
    };
    const runForwardProbe = async ({
      agentId: agentId2,
      source = "plugin_probe"
    } = {}) => {
      const payload = await post("/api/agents/gateway-forward-probe", {
        agentId: agentId2 || config.agentId || "main",
        source
      });
      const result = payload && typeof payload === "object" ? payload : {};
      const ok = Boolean(result.ok);
      lastForwardProbeState = {
        ok,
        ts: Date.now(),
        result
      };
      return result;
    };
    const runStartupGate = async ({
      autoFixGateway = true,
      force = false
    } = {}) => {
      if (startupGateRunning && !force) return startupGateRunning;
      startupGateRunning = (async () => {
        const steps = [];
        const pushStep = (entry) => steps.push(entry);
        try {
          await get("/api/system/status");
          pushStep({
            step: "solana_system_status",
            ok: true,
            ts: Date.now()
          });
        } catch (err) {
          pushStep({
            step: "solana_system_status",
            ok: false,
            ts: Date.now(),
            error: err instanceof Error ? err.message : String(err)
          });
        }
        let gatewayStepOk = false;
        try {
          const creds = await get("/api/agents/gateway-credentials");
          let activeCredential = getActiveCredential(creds);
          if (!activeCredential && autoFixGateway) {
            const gatewayBaseUrl = String(config.gatewayBaseUrl || "").trim();
            const gatewayToken = String(config.gatewayToken || "").trim();
            if (gatewayBaseUrl && gatewayToken) {
              const body = {
                gatewayBaseUrl,
                gatewayToken,
                active: true
              };
              if (config.agentId) body.agentId = config.agentId;
              await put("/api/agents/gateway-credentials", body);
            }
          }
          const refreshed = await get("/api/agents/gateway-credentials");
          activeCredential = getActiveCredential(refreshed);
          gatewayStepOk = Boolean(activeCredential);
          if (!gatewayStepOk) {
            throw new Error("Gateway credentials are missing or inactive");
          }
          pushStep({
            step: "solana_gateway_credentials_get",
            ok: true,
            ts: Date.now(),
            details: {
              active: true,
              agentId: String(activeCredential?.agentId || config.agentId || "main"),
              gatewayBaseUrl: String(activeCredential?.gatewayBaseUrl || "")
            }
          });
        } catch (err) {
          pushStep({
            step: "solana_gateway_credentials_get",
            ok: false,
            ts: Date.now(),
            error: err instanceof Error ? err.message : String(err),
            details: {
              hasConfiguredGatewayBaseUrl: Boolean(config.gatewayBaseUrl),
              hasConfiguredGatewayToken: Boolean(config.gatewayToken)
            }
          });
        }
        try {
          const effectiveAgentId = config.agentId || "main";
          if (effectiveAgentId && alphaStreamManager.getAgentId() !== effectiveAgentId) {
            alphaStreamManager.setAgentId(effectiveAgentId);
          }
          alphaStreamManager.setSubscriberType("agent");
          const subscribed = await alphaStreamManager.subscribe();
          pushStep({
            step: "solana_alpha_subscribe",
            ok: Boolean(subscribed?.subscribed),
            ts: Date.now(),
            details: {
              agentId: effectiveAgentId,
              premiumAccess: subscribed?.premiumAccess || false,
              tier: subscribed?.tier || ""
            }
          });
        } catch (err) {
          pushStep({
            step: "solana_alpha_subscribe",
            ok: false,
            ts: Date.now(),
            error: err instanceof Error ? err.message : String(err),
            details: {
              skippedBecauseGatewayFailed: !gatewayStepOk
            }
          });
        }
        try {
          await get(`/api/capital/status?walletId=${walletId}`);
          pushStep({
            step: "solana_capital_status",
            ok: true,
            ts: Date.now()
          });
        } catch (err) {
          pushStep({
            step: "solana_capital_status",
            ok: false,
            ts: Date.now(),
            error: err instanceof Error ? err.message : String(err)
          });
        }
        try {
          await get(`/api/wallet/positions?walletId=${walletId}`);
          pushStep({
            step: "solana_positions",
            ok: true,
            ts: Date.now()
          });
        } catch (err) {
          pushStep({
            step: "solana_positions",
            ok: false,
            ts: Date.now(),
            error: err instanceof Error ? err.message : String(err)
          });
        }
        try {
          await get(`/api/killswitch/status?walletId=${walletId}`);
          pushStep({
            step: "solana_killswitch_status",
            ok: true,
            ts: Date.now()
          });
        } catch (err) {
          pushStep({
            step: "solana_killswitch_status",
            ok: false,
            ts: Date.now(),
            error: err instanceof Error ? err.message : String(err)
          });
        }
        const passed = steps.filter((step) => step.ok).length;
        const failed = steps.length - passed;
        const failedSteps = steps.filter((step) => !step.ok);
        const onlyCapitalFailed = failedSteps.length === 1 && failedSteps[0]?.step === "solana_capital_status";
        startupGateState = {
          ok: failed === 0,
          ts: Date.now(),
          steps
        };
        const base = {
          ok: startupGateState.ok,
          ts: startupGateState.ts,
          steps,
          summary: { passed, failed }
        };
        const includeWelcome = startupGateState.ok || onlyCapitalFailed;
        if (includeWelcome) {
          const k = config.apiKey && String(config.apiKey).trim() || null;
          const out = { ...base, welcomeMessage: buildTraderClawWelcomeMessage(k) };
          if (onlyCapitalFailed && !startupGateState.ok) {
            return {
              ...out,
              welcomeNote: "Startup gate reported solana_capital_status failed (e.g. capital API error). Welcome message still included so the user gets onboarding text and API key; fix capital/wallet if tools keep failing."
            };
          }
          return out;
        }
        return base;
      })().finally(() => {
        startupGateRunning = null;
      });
      return startupGateRunning;
    };
    api.registerTool({
      name: "solana_alpha_subscribe",
      description: "Subscribe to the SpyFly alpha signal stream via WebSocket. Starts receiving real-time alpha signals (TG/Discord channel calls) into the buffer. Call once on first heartbeat \u2014 stays connected with auto-reconnect. Pass agentId to enable event-to-agent forwarding \u2014 orchestrator delivers each alpha signal to your Gateway via /v1/responses in addition to buffering. Returns subscription status, tier, and premium access level.",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String({ description: "Agent ID for event-to-agent forwarding (e.g., 'main'). Overrides plugin config agentId if provided." })),
        subscriberType: Type.Optional(Type.String({ description: "Subscriber type: 'agent' (default when agentId is set) or 'user'. Controls how the orchestrator routes events." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const effectiveAgentId = params.agentId || config.agentId;
        if (effectiveAgentId && alphaStreamManager.getAgentId() !== effectiveAgentId) {
          alphaStreamManager.setAgentId(effectiveAgentId);
        }
        const effectiveSubscriberType = params.subscriberType || (effectiveAgentId ? "agent" : void 0);
        if (effectiveSubscriberType) {
          alphaStreamManager.setSubscriberType(effectiveSubscriberType);
        }
        return alphaStreamManager.subscribe();
      })
    });
    api.registerTool({
      name: "solana_alpha_unsubscribe",
      description: "Unsubscribe from the SpyFly alpha signal stream and disconnect WebSocket. Use when shutting down or if kill switch is activated with TRADES_AND_STREAMS mode.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => alphaStreamManager.unsubscribe())
    });
    api.registerTool({
      name: "solana_alpha_signals",
      description: "Get buffered alpha signals from the SpyFly stream. By default returns only unseen signals and marks them as seen. Use minScore to filter low-quality signals. Poll this every heartbeat cycle in Step 1.5b. Returns signals sorted by ingestion time (newest last).",
      parameters: Type.Object({
        minScore: Type.Optional(Type.Number({ description: "Minimum systemScore threshold (0-100). Signals below this are excluded." })),
        chain: Type.Optional(Type.String({ description: "Filter by chain (e.g., 'solana'). BSC is already filtered at ingestion." })),
        kinds: Type.Optional(Type.Array(Type.String(), { description: "Filter by signal kind: 'ca_drop', 'milestone', 'update', 'risk', 'exit'" })),
        unseen: Type.Optional(Type.Boolean({ description: "If true (default), return only unseen signals and mark them as seen. Set false to get all buffered signals." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const signals = alphaBuffer.getSignals({
          minScore: params.minScore,
          chain: params.chain,
          kinds: params.kinds,
          unseen: params.unseen !== void 0 ? params.unseen : true
        });
        return {
          signals,
          count: signals.length,
          bufferSize: alphaBuffer.getBufferSize(),
          subscribed: alphaStreamManager.isSubscribed(),
          stats: alphaStreamManager.getStats()
        };
      })
    });
    api.registerTool({
      name: "solana_alpha_history",
      description: "Query historical alpha signal data via the SpyFly REST API (GET /api/pings). Returns up to 1 year of stored signals for source reputation analysis, post-downtime catch-up, and strategy learning. Tier-gated: starter=10, pro=50, enterprise=200 results. 99.99% of tokens are dead but source patterns are invaluable.",
      parameters: Type.Object({
        tokenAddress: Type.Optional(Type.String({ description: "Filter by token mint address" })),
        channelId: Type.Optional(Type.String({ description: "Filter by source channel ID" })),
        limit: Type.Optional(Type.Number({ description: "Max results (tier-capped: starter=10, pro=50, enterprise=200)" })),
        days: Type.Optional(Type.Number({ description: "Look back period in days. Converted to then/now timestamp range." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const queryParts = [];
        if (params.limit) queryParts.push(`limit=${params.limit}`);
        if (params.channelId) queryParts.push(`channelId=${params.channelId}`);
        if (params.days) {
          const now = Date.now();
          const then = now - params.days * 24 * 60 * 60 * 1e3;
          queryParts.push(`then=${then}`);
          queryParts.push(`now=${now}`);
        }
        if (params.tokenAddress) queryParts.push(`tokenAddress=${params.tokenAddress}`);
        const qs = queryParts.length > 0 ? `?${queryParts.join("&")}` : "";
        return get(`/api/pings${qs}`);
      })
    });
    api.registerTool({
      name: "solana_alpha_sources",
      description: "Get per-source statistics from the alpha signal buffer \u2014 signal count, average systemScore, and source type for each channel. Use for quick reputation checks during signal processing and to identify high-quality vs low-quality sources.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => ({
        sources: alphaBuffer.getSourceStatsAll(),
        bufferSize: alphaBuffer.getBufferSize(),
        subscribed: alphaStreamManager.isSubscribed()
      }))
    });
    api.registerTool({
      name: "solana_system_status",
      description: "Check orchestrator system health \u2014 uptime, connected services, database status, execution mode, and upstream API connectivity.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => get("/api/system/status"))
    });
    api.registerTool({
      name: "solana_startup_gate",
      description: "Run the mandatory startup sequence and return deterministic pass/fail results per step. Optionally auto-fixes gateway credentials if gatewayBaseUrl and gatewayToken are present in plugin config. On full pass, includes welcomeMessage. If the only failed step is solana_capital_status (e.g. capital API error), still includes welcomeMessage so the user gets onboarding text; check welcomeNote in that case.",
      parameters: Type.Object({
        autoFixGateway: Type.Optional(Type.Boolean({ description: "If true (default), auto-register gateway credentials when missing and config includes gatewayBaseUrl + gatewayToken." })),
        force: Type.Optional(Type.Boolean({ description: "If true, always run the startup checks now even if a recent run exists." }))
      }),
      execute: wrapExecute(
        async (_id, params) => runStartupGate({
          autoFixGateway: params.autoFixGateway !== void 0 ? Boolean(params.autoFixGateway) : true,
          force: Boolean(params.force)
        })
      )
    });
    api.registerTool({
      name: "solana_traderclaw_welcome",
      description: "Returns the canonical TraderClaw welcome message for the user after startup checks succeed (including when the only issue is zero balance \u2014 funding is separate). Includes API key when stored in plugin config. Use when the user ran the manual startup checklist instead of solana_startup_gate, or whenever welcomeMessage was not already appended from solana_startup_gate.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => {
        const k = config.apiKey && String(config.apiKey).trim() || null;
        return { welcomeMessage: buildTraderClawWelcomeMessage(k) };
      })
    });
    api.registerTool({
      name: "solana_gateway_forward_probe",
      description: "Run a synthetic orchestrator-to-gateway forwarding probe for /v1/responses and return latency plus failure diagnostics.",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String({ description: "Agent ID to probe (default: plugin config agentId or 'main')." })),
        source: Type.Optional(Type.String({ description: "Probe source label for diagnostics." }))
      }),
      execute: wrapExecute(
        async (_id, params) => runForwardProbe({
          agentId: params.agentId ? String(params.agentId) : void 0,
          source: params.source ? String(params.source) : "plugin_probe_tool"
        })
      )
    });
    api.registerTool({
      name: "solana_runtime_status",
      description: "Return plugin runtime diagnostics including startup-gate cache, alpha stream status, and latest forwarding probe result.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => ({
        startupGate: startupGateState,
        alphaStream: {
          subscribed: alphaStreamManager.isSubscribed(),
          stats: alphaStreamManager.getStats(),
          bufferSize: alphaBuffer.getBufferSize()
        },
        lastForwardProbe: lastForwardProbeState
      }))
    });
    api.registerTool({
      name: "solana_state_save",
      description: "Persist durable agent state to local JSON and mirror a human-readable summary to workspace STATE.md (~/.openclaw/workspace/STATE.md). Deep merge: new keys are added, existing keys updated, omitted keys preserved. Does not overwrite the agent's MEMORY.md. Use for: strategy weights cache, watchlists, running counters, regime observations, any data that must survive session boundaries.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent ID whose state to save (must match calling agent)." }),
        state: Type.Unknown({ description: "JSON object to deep-merge into existing state. New keys are added, existing keys are updated, omitted keys are preserved." }),
        overwrite: Type.Optional(Type.Boolean({ description: "If true, replace entire state instead of merging. Default false." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const targetAgentId = sanitizeAgentId(String(params.agentId));
        const filePath = path.join(stateDir, `${targetAgentId}.json`);
        const shouldOverwrite = Boolean(params.overwrite);
        let mergedState;
        if (shouldOverwrite) {
          mergedState = params.state;
        } else {
          const existing = readJsonFile(filePath);
          const existingState = existing?.state && typeof existing.state === "object" ? existing.state : {};
          const newState = params.state && typeof params.state === "object" ? params.state : params.state;
          if (typeof existingState === "object" && typeof newState === "object" && newState !== null) {
            mergedState = deepMerge(existingState, newState);
          } else {
            mergedState = newState;
          }
        }
        const payload = { agentId: targetAgentId, state: mergedState, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
        writeJsonFile(filePath, payload);
        writeStateMd(targetAgentId, mergedState);
        return { ok: true, agentId: targetAgentId, updatedAt: payload.updatedAt, merged: !shouldOverwrite, stateMdWritten: true };
      })
    });
    api.registerTool({
      name: "solana_state_read",
      description: "Read durable agent state from local storage. Returns the last saved state object or null if no state exists. Also auto-injected at bootstrap \u2014 this tool is for mid-session reads.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent ID whose state to read." })
      }),
      execute: wrapExecute(async (_id, params) => {
        const targetAgentId = sanitizeAgentId(String(params.agentId));
        const filePath = path.join(stateDir, `${targetAgentId}.json`);
        const data = readJsonFile(filePath);
        return data || { agentId: targetAgentId, state: null, updatedAt: null };
      })
    });
    api.registerTool({
      name: "solana_decision_log",
      description: "Append a structured decision entry to the agent's episodic decision log. Maintains the last 50 entries per agent (FIFO). Entries are auto-injected at bootstrap for session continuity. Use for: trade decisions, analysis conclusions, relay actions, skip reasons.",
      parameters: Type.Object({
        agentId: Type.String({ description: "Agent ID writing the decision." }),
        type: Type.String({ description: "Decision type: 'trade_entry', 'trade_exit', 'skip', 'watch', 'relay', 'analysis', 'alert', 'cron_result'." }),
        token: Type.Optional(Type.String({ description: "Token mint address if decision relates to a specific token." })),
        rationale: Type.String({ description: "Brief reasoning for the decision (< 500 chars)." }),
        scores: Type.Optional(Type.Unknown({ description: "Relevant scores object (confidence, analyst scores, etc.)." })),
        outcome: Type.Optional(Type.String({ description: "Outcome if known: 'pending', 'win', 'loss', 'neutral'." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const targetAgentId = sanitizeAgentId(String(params.agentId));
        const logPath = path.join(logsDir, targetAgentId, "decisions.jsonl");
        const entry = {
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          agentId: targetAgentId,
          type: String(params.type),
          token: params.token ? String(params.token) : void 0,
          rationale: String(params.rationale),
          scores: params.scores || void 0,
          outcome: params.outcome ? String(params.outcome) : "pending"
        };
        const count = appendJsonlFile(logPath, entry, 50);
        return { ok: true, agentId: targetAgentId, entryCount: count };
      })
    });
    api.registerTool({
      name: "solana_team_bulletin_post",
      description: "Post a finding or alert to the shared team bulletin board. All agents can read the bulletin. Maintains last 200 entries with 3-day retention. Use for: broadcasting discoveries, risk alerts, regime observations, cross-agent coordination signals.",
      parameters: Type.Object({
        fromAgent: Type.String({ description: "Posting agent's ID." }),
        type: Type.String({ description: "Bulletin type: 'discovery', 'risk_alert', 'regime_shift', 'position_update', 'convergence', 'exhaustion', 'whale_move', 'source_rep_update', 'pattern_match'." }),
        priority: Type.String({ description: "Priority: 'low', 'medium', 'high', 'critical'." }),
        payload: Type.Unknown({ description: "Structured payload relevant to the bulletin type." })
      }),
      execute: wrapExecute(async (_id, params) => {
        const fromAgent = sanitizeAgentId(String(params.fromAgent));
        const bulletinPath = path.join(sharedLogsDir, "team-bulletin.jsonl");
        const now = /* @__PURE__ */ new Date();
        const entry = {
          ts: now.toISOString(),
          fromAgent,
          type: String(params.type),
          priority: String(params.priority),
          payload: params.payload
        };
        let entries = readJsonlFile(bulletinPath);
        const threeDaysAgo = now.getTime() - 3 * 24 * 60 * 60 * 1e3;
        entries = entries.filter((e) => new Date(e.ts).getTime() > threeDaysAgo);
        entries.push(entry);
        if (entries.length > 200) entries = entries.slice(-200);
        fs.writeFileSync(bulletinPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
        return { ok: true, entryCount: entries.length };
      })
    });
    api.registerTool({
      name: "solana_team_bulletin_read",
      description: "Read entries from the shared team bulletin board with optional filters. Returns entries in chronological order.",
      parameters: Type.Object({
        since: Type.Optional(Type.String({ description: "ISO timestamp \u2014 only return entries after this time." })),
        fromAgent: Type.Optional(Type.String({ description: "Filter by posting agent ID." })),
        type: Type.Optional(Type.String({ description: "Filter by bulletin type." })),
        limit: Type.Optional(Type.Number({ description: "Max entries to return (default 50)." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const bulletinPath = path.join(sharedLogsDir, "team-bulletin.jsonl");
        let entries = readJsonlFile(bulletinPath);
        if (params.since) {
          const sinceTs = new Date(String(params.since)).getTime();
          entries = entries.filter((e) => new Date(String(e.ts)).getTime() > sinceTs);
        }
        if (params.fromAgent) entries = entries.filter((e) => e.fromAgent === String(params.fromAgent));
        if (params.type) entries = entries.filter((e) => e.type === String(params.type));
        const limit = typeof params.limit === "number" ? params.limit : 50;
        return { entries: entries.slice(-limit), total: entries.length };
      })
    });
    api.registerTool({
      name: "solana_context_snapshot_write",
      description: "Write the portfolio context snapshot. CTO writes this at the end of each session to give all agents a consistent world-view at next bootstrap. Contains: open positions, capital state, active regime, recent decisions summary, strategy version.",
      parameters: Type.Object({
        snapshot: Type.Unknown({ description: "Context snapshot object with positions, capital, regime, strategyVersion, activeSubscriptions, recentDecisions summary." })
      }),
      execute: wrapExecute(async (_id, params) => {
        const filePath = path.join(stateDir, "context-snapshot.json");
        const payload = { snapshot: params.snapshot, writtenBy: agentId, ts: (/* @__PURE__ */ new Date()).toISOString() };
        writeJsonFile(filePath, payload);
        return { ok: true, ts: payload.ts };
      })
    });
    api.registerTool({
      name: "solana_context_snapshot_read",
      description: "Read the latest portfolio context snapshot written by the CTO. Provides a consistent world-view: open positions, capital, regime, strategy version. Also auto-injected at bootstrap.",
      parameters: Type.Object({}),
      execute: wrapExecute(async () => {
        const filePath = path.join(stateDir, "context-snapshot.json");
        const data = readJsonFile(filePath);
        return data || { snapshot: null, ts: null };
      })
    });
    api.registerTool({
      name: "solana_compute_confidence",
      description: "Deterministic confidence score computation. Applies the V2 weighted formula with convergence bonus and risk penalty. Returns the computed score with full breakdown \u2014 no hallucination possible.",
      parameters: Type.Object({
        onchainScore: Type.Number({ description: "On-Chain Analyst score (0.0-1.0)." }),
        signalScore: Type.Number({ description: "Alpha Signal Analyst score (0.0-1.0)." }),
        socialScore: Type.Optional(Type.Number({ description: "Social Intelligence Analyst score (0.0-1.0). Default 0." })),
        smartMoneyScore: Type.Optional(Type.Number({ description: "Smart Money Tracker score (0.0-1.0). Default 0." })),
        riskPenalty: Type.Number({ description: "Risk penalty from Risk Officer flags, hardDeny, manipulation, liquidity, front-running, late freshness." }),
        weights: Type.Optional(Type.Object({
          onchain: Type.Optional(Type.Number()),
          signal: Type.Optional(Type.Number()),
          social: Type.Optional(Type.Number()),
          smart: Type.Optional(Type.Number())
        }, { description: "Custom weights. Default: onchain=0.45, signal=0.35, social=0.05, smart=0.15." })),
        convergenceSources: Type.Optional(Type.Number({ description: "Number of independent discovery sources that flagged same token. 2=+0.15, 3=+0.20, 4+=+0.25." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const onchain = Number(params.onchainScore) || 0;
        const signal = Number(params.signalScore) || 0;
        const social = Number(params.socialScore) || 0;
        const smart = Number(params.smartMoneyScore) || 0;
        const penalty = Number(params.riskPenalty) || 0;
        const w = params.weights;
        const wOnchain = w?.onchain ?? 0.45;
        const wSignal = w?.signal ?? 0.35;
        const wSocial = w?.social ?? 0.05;
        const wSmart = w?.smart ?? 0.15;
        const sources = Number(params.convergenceSources) || 0;
        let convergenceBonus = 0;
        if (sources >= 4) convergenceBonus = 0.25;
        else if (sources >= 3) convergenceBonus = 0.2;
        else if (sources >= 2) convergenceBonus = 0.15;
        const raw = wOnchain * onchain + wSignal * signal + wSocial * social + wSmart * smart;
        const confidence = Math.max(0, Math.min(1, raw - penalty + convergenceBonus));
        return {
          confidence: Math.round(confidence * 1e4) / 1e4,
          raw: Math.round(raw * 1e4) / 1e4,
          convergenceBonus,
          riskPenalty: penalty,
          weights: { onchain: wOnchain, signal: wSignal, social: wSocial, smart: wSmart },
          components: {
            onchain: Math.round(wOnchain * onchain * 1e4) / 1e4,
            signal: Math.round(wSignal * signal * 1e4) / 1e4,
            social: Math.round(wSocial * social * 1e4) / 1e4,
            smart: Math.round(wSmart * smart * 1e4) / 1e4
          },
          formula: `(${wOnchain}\xD7${onchain}) + (${wSignal}\xD7${signal}) + (${wSocial}\xD7${social}) + (${wSmart}\xD7${smart}) - ${penalty} + ${convergenceBonus} = ${confidence.toFixed(4)}`
        };
      })
    });
    api.registerTool({
      name: "solana_compute_freshness_decay",
      description: "Compute signal freshness decay factor based on signal age. Returns a 0.0-1.0 multiplier and age category. Deterministic \u2014 no API calls.",
      parameters: Type.Object({
        signalAgeMinutes: Type.Number({ description: "Age of the signal in minutes since original call." }),
        signalType: Type.Optional(Type.String({ description: "Signal type: 'ca_drop' (default), 'exit', 'sentiment', 'confirmation'." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const age = Number(params.signalAgeMinutes) || 0;
        const signalType = String(params.signalType || "ca_drop");
        let decay = 1;
        let category = "EARLY";
        let recommendation = "PROCEED";
        if (signalType === "exit" || signalType === "sentiment") {
          if (age <= 5) {
            decay = 1;
            category = "IMMEDIATE";
          } else if (age <= 15) {
            decay = 0.8;
            category = "RECENT";
          } else if (age <= 30) {
            decay = 0.5;
            category = "AGING";
            recommendation = "REDUCE_WEIGHT";
          } else {
            decay = 0.2;
            category = "STALE";
            recommendation = "SKIP";
          }
        } else {
          if (age <= 3) {
            decay = 1;
            category = "EARLY";
          } else if (age <= 10) {
            decay = 0.9;
            category = "ONTIME";
          } else if (age <= 30) {
            decay = 0.7;
            category = "LATE";
            recommendation = "REDUCE_SIZE";
          } else if (age <= 60) {
            decay = 0.4;
            category = "VERY_LATE";
            recommendation = "WATCH_ONLY";
          } else {
            decay = 0.1;
            category = "STALE";
            recommendation = "SKIP";
          }
        }
        return { decayFactor: decay, ageMinutes: age, ageCategory: category, recommendation, signalType };
      })
    });
    api.registerTool({
      name: "solana_compute_position_limits",
      description: "Compute final position size after all stacked reductions. Applies mode-based range \u2192 Risk Officer cap \u2192 precheck cap \u2192 liquidity hard cap \u2192 reduction triggers \u2192 floor. Returns sizeSol with full reduction breakdown. Deterministic.",
      parameters: Type.Object({
        mode: Type.String({ description: "'HARDENED' or 'DEGEN'." }),
        confidence: Type.Number({ description: "Confidence score (0.0-1.0)." }),
        capitalSol: Type.Number({ description: "Total available capital in SOL." }),
        poolDepthUsd: Type.Number({ description: "Pool liquidity depth in USD." }),
        solPriceUsd: Type.Number({ description: "Current SOL price in USD for pool-depth conversion." }),
        lifecycle: Type.String({ description: "'FRESH', 'EMERGING', or 'ESTABLISHED'." }),
        winRateLast10: Type.Optional(Type.Number({ description: "Win rate over last 10 trades (0.0-1.0)." })),
        dailyNotionalUsedPct: Type.Optional(Type.Number({ description: "Daily notional used as percentage (0-100)." })),
        consecutiveLosses: Type.Optional(Type.Number({ description: "Current consecutive loss count." })),
        openPositionCount: Type.Optional(Type.Number({ description: "Number of open positions." })),
        tokenConcentrationPct: Type.Optional(Type.Number({ description: "Token concentration percentage (0-100)." })),
        priceMovePct: Type.Optional(Type.Number({ description: "Token price move percentage from recent low." })),
        riskOfficerMaxSizeSol: Type.Optional(Type.Number({ description: "Risk Officer's maxSizeSol cap." })),
        precheckCappedSizeSol: Type.Optional(Type.Number({ description: "Precheck cappedSizeSol." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const mode = String(params.mode).toUpperCase();
        const isHardened = mode === "HARDENED";
        const confidence = Number(params.confidence) || 0;
        const capital = Number(params.capitalSol) || 0;
        const poolUsd = Number(params.poolDepthUsd) || 0;
        const solPrice = Number(params.solPriceUsd) || 1;
        const lifecycle = String(params.lifecycle).toUpperCase();
        const reductions = [];
        const highMin = isHardened ? 0.1 : 0.12;
        const highMax = isHardened ? 0.2 : 0.25;
        const exploMin = isHardened ? 0.03 : 0.05;
        const exploMax = isHardened ? 0.08 : 0.1;
        const isHighConf = confidence > 0.75;
        let baseMin = isHighConf ? highMin : exploMin;
        let baseMax = isHighConf ? highMax : exploMax;
        if (lifecycle === "FRESH") {
          baseMin = exploMin;
          baseMax = isHardened ? 0.05 : exploMax;
        }
        let sizeSol = capital * ((baseMin + baseMax) / 2);
        const riskMax = params.riskOfficerMaxSizeSol != null ? Number(params.riskOfficerMaxSizeSol) : Infinity;
        if (riskMax < sizeSol) {
          reductions.push({ factor: riskMax / sizeSol, reason: "Risk Officer maxSizeSol cap" });
          sizeSol = riskMax;
        }
        const precheckCap = params.precheckCappedSizeSol != null ? Number(params.precheckCappedSizeSol) : Infinity;
        if (precheckCap < sizeSol) {
          reductions.push({ factor: precheckCap / sizeSol, reason: "Precheck cappedSizeSol" });
          sizeSol = precheckCap;
        }
        const poolCapSol = poolUsd * 0.02 / solPrice;
        const poolHardCapSol = poolUsd < 5e4 ? 1e3 / solPrice : Infinity;
        const effectivePoolCap = Math.min(poolCapSol, poolHardCapSol);
        if (effectivePoolCap < sizeSol) {
          reductions.push({ factor: effectivePoolCap / sizeSol, reason: poolUsd < 5e4 ? "Pool < $50K hard cap ($1K max)" : "2% pool depth cap" });
          sizeSol = effectivePoolCap;
        }
        const wr = params.winRateLast10 != null ? Number(params.winRateLast10) : 1;
        if (wr < 0.4) {
          sizeSol *= 0.6;
          reductions.push({ factor: 0.6, reason: "Win rate < 40%" });
        }
        const dnPct = params.dailyNotionalUsedPct != null ? Number(params.dailyNotionalUsedPct) : 0;
        if (dnPct > 70) {
          sizeSol *= 0.5;
          reductions.push({ factor: 0.5, reason: "Daily notional > 70%" });
        }
        const consLoss = params.consecutiveLosses != null ? Number(params.consecutiveLosses) : 0;
        if (consLoss >= 2) {
          sizeSol *= 0.7;
          reductions.push({ factor: 0.7, reason: `${consLoss} consecutive losses` });
        }
        const openPos = params.openPositionCount != null ? Number(params.openPositionCount) : 0;
        if (openPos >= 3) {
          sizeSol *= 0.8;
          reductions.push({ factor: 0.8, reason: `${openPos} open positions` });
        }
        const concPct = params.tokenConcentrationPct != null ? Number(params.tokenConcentrationPct) : 0;
        if (concPct > 30) {
          sizeSol *= 0.5;
          reductions.push({ factor: 0.5, reason: "Token concentration > 30%" });
        }
        const pricePct = params.priceMovePct != null ? Number(params.priceMovePct) : 0;
        if (pricePct > 200) {
          sizeSol *= 0.5;
          reductions.push({ factor: 0.5, reason: "Token moved +200%" });
        }
        const floorPct = isHardened ? 75e-4 : 0.0125;
        const floor = capital * floorPct;
        if (sizeSol < floor) {
          sizeSol = floor;
          reductions.push({ factor: 1, reason: `Floor applied: ${(floorPct * 100).toFixed(2)}% of capital` });
        }
        return {
          sizeSol: Math.round(sizeSol * 1e4) / 1e4,
          mode,
          baseRange: { min: baseMin, max: baseMax },
          poolCap: Math.round(effectivePoolCap * 1e4) / 1e4,
          floor: Math.round(floor * 1e4) / 1e4,
          reductions
        };
      })
    });
    api.registerTool({
      name: "solana_classify_deployer_risk",
      description: "Classify deployer wallet risk level based on history. Returns risk class, score, and flags. Deterministic computation \u2014 no API calls.",
      parameters: Type.Object({
        previousTokens: Type.Number({ description: "Number of tokens previously deployed by this wallet." }),
        rugHistory: Type.Boolean({ description: "Whether any previous token was a confirmed rug." }),
        avgTokenLifespanHours: Type.Optional(Type.Number({ description: "Average lifespan of previous tokens in hours." })),
        freshWalletSurge: Type.Optional(Type.Number({ description: "Fresh wallet surge ratio (0.0-1.0) for this deployer's tokens." })),
        devSoldEarlyCount: Type.Optional(Type.Number({ description: "Number of previous tokens where dev sold within first hour." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const prev = Number(params.previousTokens) || 0;
        const rugged = Boolean(params.rugHistory);
        const avgLife = params.avgTokenLifespanHours != null ? Number(params.avgTokenLifespanHours) : null;
        const freshSurge = params.freshWalletSurge != null ? Number(params.freshWalletSurge) : 0;
        const devSold = params.devSoldEarlyCount != null ? Number(params.devSoldEarlyCount) : 0;
        const flags = [];
        let score = 0;
        if (rugged) {
          score += 40;
          flags.push("CONFIRMED_RUG_HISTORY");
        }
        if (prev >= 10) {
          score += 20;
          flags.push("SERIAL_DEPLOYER");
        } else if (prev >= 5) {
          score += 10;
          flags.push("FREQUENT_DEPLOYER");
        }
        if (avgLife !== null && avgLife < 2) {
          score += 15;
          flags.push("SHORT_LIVED_TOKENS");
        }
        if (freshSurge > 0.5) {
          score += 15;
          flags.push("HIGH_FRESH_WALLET_SURGE");
        }
        if (devSold > 0 && prev > 0 && devSold / prev > 0.5) {
          score += 10;
          flags.push("FREQUENT_EARLY_DEV_SELLS");
        }
        let riskClass;
        if (score >= 50) riskClass = "CRITICAL";
        else if (score >= 30) riskClass = "HIGH";
        else if (score >= 15) riskClass = "MODERATE";
        else riskClass = "LOW";
        return { riskClass, score, flags, inputs: { previousTokens: prev, rugHistory: rugged, avgTokenLifespanHours: avgLife, freshWalletSurge: freshSurge, devSoldEarlyCount: devSold } };
      })
    });
    api.registerTool({
      name: "solana_history_export",
      description: "Export comprehensive historical data for analysis: local decision logs + server-side closed trades + memory entries + strategy evolution history. Supports filtering by agent, time range, decision type, and token. Designed for deep analysis with full lookback depth.",
      parameters: Type.Object({
        agentId: Type.Optional(Type.String({ description: "Agent ID to export local logs for. Defaults to configured agent." })),
        since: Type.Optional(Type.String({ description: "ISO timestamp \u2014 only export entries after this time." })),
        before: Type.Optional(Type.String({ description: "ISO timestamp \u2014 only export entries before this time." })),
        decisionType: Type.Optional(Type.String({ description: "Filter local decisions by type (e.g., 'trade_entry', 'trade_exit', 'analysis')." })),
        token: Type.Optional(Type.String({ description: "Filter decisions and memory by token mint address." })),
        includeState: Type.Optional(Type.Boolean({ description: "Include agent durable state. Default true." })),
        includeBulletin: Type.Optional(Type.Boolean({ description: "Include team bulletin entries. Default false." })),
        includePatterns: Type.Optional(Type.Boolean({ description: "Include named patterns. Default false." })),
        includeTrades: Type.Optional(Type.Boolean({ description: "Include server-side closed trade history (via /api/trades). Default true." })),
        includeMemory: Type.Optional(Type.Boolean({ description: "Include server-side memory entries matching filters (via /api/memory/search). Default false." })),
        includeStrategy: Type.Optional(Type.Boolean({ description: "Include server-side strategy state and weight history (via /api/strategy/state). Default false." })),
        memoryTags: Type.Optional(Type.String({ description: "Comma-separated memory tags to search (used with includeMemory). Default: 'learning_entry,strategy_evolution,pattern_detection'." })),
        limit: Type.Optional(Type.Number({ description: "Max decision entries (local logs). Default 50." })),
        offset: Type.Optional(Type.Number({ description: "Skip first N decision entries. Default 0." })),
        tradesLimit: Type.Optional(Type.Number({ description: "Max closed trades to fetch. Default 100." })),
        tradesPage: Type.Optional(Type.Number({ description: "Page number for trade pagination (1-based). Default 1." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const targetAgentId = sanitizeAgentId(params.agentId ? String(params.agentId) : agentId);
        const sinceTs = params.since ? new Date(String(params.since)).getTime() : 0;
        const beforeTs = params.before ? new Date(String(params.before)).getTime() : Infinity;
        const filterType = params.decisionType ? String(params.decisionType) : null;
        const filterToken = params.token ? String(params.token) : null;
        const maxEntries = typeof params.limit === "number" ? params.limit : 50;
        const skipEntries = typeof params.offset === "number" ? params.offset : 0;
        const includeState = params.includeState !== false;
        const shouldFetchTrades = params.includeTrades !== false;
        const shouldFetchMemory = Boolean(params.includeMemory);
        const shouldFetchStrategy = Boolean(params.includeStrategy);
        const logPath = path.join(logsDir, targetAgentId, "decisions.jsonl");
        let decisions = readJsonlFile(logPath);
        if (sinceTs > 0) decisions = decisions.filter((d) => new Date(d.ts).getTime() > sinceTs);
        if (beforeTs < Infinity) decisions = decisions.filter((d) => new Date(d.ts).getTime() < beforeTs);
        if (filterType) decisions = decisions.filter((d) => d.type === filterType);
        if (filterToken) decisions = decisions.filter((d) => d.token === filterToken);
        const totalFiltered = decisions.length;
        decisions = decisions.slice(skipEntries, skipEntries + maxEntries);
        const agentResult = {
          decisions,
          decisionCount: decisions.length,
          totalFiltered
        };
        if (includeState) {
          const statePath = path.join(stateDir, `${targetAgentId}.json`);
          agentResult.state = readJsonFile(statePath);
        }
        const exportResult = {
          agents: { [targetAgentId]: agentResult },
          exportedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        exportResult.contextSnapshot = readJsonFile(path.join(stateDir, "context-snapshot.json"));
        if (params.includeBulletin) {
          let bulletin = readJsonlFile(path.join(sharedLogsDir, "team-bulletin.jsonl"));
          if (sinceTs > 0) bulletin = bulletin.filter((b) => new Date(b.ts).getTime() > sinceTs);
          if (beforeTs < Infinity) bulletin = bulletin.filter((b) => new Date(b.ts).getTime() < beforeTs);
          exportResult.bulletin = bulletin.slice(-maxEntries);
        }
        if (params.includePatterns) {
          exportResult.patterns = readJsonFile(path.join(stateDir, "patterns.json")) || {};
        }
        if (shouldFetchTrades) {
          try {
            const trLimit = typeof params.tradesLimit === "number" ? params.tradesLimit : 100;
            const trPage = typeof params.tradesPage === "number" ? params.tradesPage : 1;
            let tradePath = `/api/trades?walletId=${walletId}&limit=${trLimit}&page=${trPage}`;
            if (filterToken) tradePath += `&tokenAddress=${filterToken}`;
            const trades = await get(tradePath);
            exportResult.closedTrades = trades;
          } catch (err) {
            exportResult.closedTrades = { error: err instanceof Error ? err.message : String(err) };
          }
        }
        if (shouldFetchMemory) {
          try {
            const tags = params.memoryTags ? String(params.memoryTags).split(",").map((t) => t.trim()) : ["learning_entry", "strategy_evolution", "pattern_detection"];
            const memoryResults = [];
            for (const tag of tags) {
              try {
                const entries = await post("/api/memory/search", { query: tag, walletId });
                memoryResults.push({ tag, entries });
              } catch {
              }
            }
            exportResult.memoryEntries = memoryResults;
          } catch (err) {
            exportResult.memoryEntries = { error: err instanceof Error ? err.message : String(err) };
          }
        }
        if (shouldFetchStrategy) {
          try {
            const strategyState = await get("/api/strategy/state");
            exportResult.strategyState = strategyState;
          } catch (err) {
            exportResult.strategyState = { error: err instanceof Error ? err.message : String(err) };
          }
        }
        return exportResult;
      })
    });
    api.registerTool({
      name: "solana_pattern_store",
      description: "Read, write, or list named trading patterns. Patterns are shared state used for pattern matching and strategy evolution.",
      parameters: Type.Object({
        action: Type.String({ description: "'read', 'write', or 'list'." }),
        patternId: Type.Optional(Type.String({ description: "Pattern identifier (required for read/write)." })),
        pattern: Type.Optional(Type.Unknown({ description: "Pattern object to store (required for write). Should include: name, description, conditions, expectedOutcome, confidence, sampleSize, discoveredAt." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        const action = String(params.action);
        const patternsPath = path.join(stateDir, "patterns.json");
        const patterns = readJsonFile(patternsPath) || {};
        if (action === "list") {
          const ids = Object.keys(patterns);
          return { patterns: ids.map((id) => ({ id, ...patterns[id] })), count: ids.length };
        }
        const patternId = params.patternId ? String(params.patternId) : null;
        if (!patternId) return { error: "patternId is required for read/write." };
        if (action === "read") {
          return patterns[patternId] ? { patternId, ...patterns[patternId] } : { patternId, found: false };
        }
        if (action === "write") {
          if (!params.pattern) return { error: "pattern object is required for write." };
          patterns[patternId] = { ...params.pattern, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
          writeJsonFile(patternsPath, patterns);
          return { ok: true, patternId, updatedAt: patterns[patternId].updatedAt };
        }
        return { error: `Unknown action: ${action}. Use 'read', 'write', or 'list'.` };
      })
    });
    api.registerTool({
      name: "solana_daily_log",
      description: "Append an entry to today's daily episodic log (memory/YYYY-MM-DD.md). OpenClaw auto-loads today + yesterday's log into context at every session start \u2014 no tool call needed to read them. Use at session end and after significant events. Auto-prunes logs older than 7 days.",
      parameters: Type.Object({
        summary: Type.String({ description: "Session summary or event description to log. Keep concise (1-5 lines)." }),
        tags: Type.Optional(Type.String({ description: "Comma-separated tags for categorization (e.g., 'trade,regime_shift,session_end')." }))
      }),
      execute: wrapExecute(async (_id, params) => {
        ensureDir(memoryDir);
        const now = /* @__PURE__ */ new Date();
        const logPath = getDailyLogPath(now);
        const timeStr = now.toISOString().slice(11, 19);
        const tags = params.tags ? ` [${String(params.tags)}]` : "";
        const entry = `
### ${timeStr} \u2014 ${agentId}${tags}

${String(params.summary)}
`;
        if (!fs.existsSync(logPath)) {
          const dateStr = now.toISOString().slice(0, 10);
          const header = `# Daily Log \u2014 ${dateStr}

> Auto-generated by solana_daily_log. OpenClaw loads today + yesterday into context automatically.
`;
          fs.writeFileSync(logPath, header + entry, "utf-8");
        } else {
          fs.appendFileSync(logPath, entry, "utf-8");
        }
        pruneDailyLogs(7);
        return { ok: true, date: now.toISOString().slice(0, 10), time: timeStr, agent: agentId };
      })
    });
    api.registerHook("agent:bootstrap", async (context) => {
      const bootAgentId = sanitizeAgentId(context.agentId || agentId);
      if (!context.bootstrapFiles) context.bootstrapFiles = [];
      try {
        const stateFile = path.join(stateDir, `${bootAgentId}.json`);
        const stateData = readJsonFile(stateFile);
        if (stateData) {
          context.bootstrapFiles.push({
            name: `${bootAgentId}-durable-state.json`,
            path: `state/${bootAgentId}.json`,
            content: JSON.stringify(stateData, null, 2),
            source: "solana-trader:state"
          });
        }
      } catch (err) {
        api.logger.warn(`[solana-trader] Bootstrap: failed to load state for ${bootAgentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const logFile = path.join(logsDir, bootAgentId, "decisions.jsonl");
        const decisions = readJsonlFile(logFile, 50);
        if (decisions.length > 0) {
          context.bootstrapFiles.push({
            name: `${bootAgentId}-decision-log.jsonl`,
            path: `logs/${bootAgentId}/decisions.jsonl`,
            content: decisions.map((d) => JSON.stringify(d)).join("\n"),
            source: "solana-trader:decisions"
          });
        }
      } catch (err) {
        api.logger.warn(`[solana-trader] Bootstrap: failed to load decisions for ${bootAgentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const bulletinFile = path.join(sharedLogsDir, "team-bulletin.jsonl");
        const allEntries = readJsonlFile(bulletinFile);
        const windowMs = 6 * 60 * 60 * 1e3;
        const cutoff = Date.now() - windowMs;
        const filtered = allEntries.filter((e) => new Date(e.ts).getTime() > cutoff);
        if (filtered.length > 0) {
          context.bootstrapFiles.push({
            name: "team-bulletin.jsonl",
            path: "logs/shared/team-bulletin.jsonl",
            content: filtered.map((e) => JSON.stringify(e)).join("\n"),
            source: "solana-trader:bulletin"
          });
        }
      } catch (err) {
        api.logger.warn(`[solana-trader] Bootstrap: failed to load bulletin for ${bootAgentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const snapshotFile = path.join(stateDir, "context-snapshot.json");
        const snapshot = readJsonFile(snapshotFile);
        if (snapshot) {
          context.bootstrapFiles.push({
            name: "context-snapshot.json",
            path: "state/context-snapshot.json",
            content: JSON.stringify(snapshot, null, 2),
            source: "solana-trader:snapshot"
          });
        }
      } catch (err) {
        api.logger.warn(`[solana-trader] Bootstrap: failed to load snapshot for ${bootAgentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      let entitlementData = null;
      try {
        const liveResult = await get(`/api/entitlements/current?walletId=${walletId}`);
        if (liveResult && typeof liveResult === "object") {
          entitlementData = { ...liveResult, source: "live-fetch", cachedAt: (/* @__PURE__ */ new Date()).toISOString() };
          try {
            writeJsonFile(path.join(stateDir, "entitlement-cache.json"), entitlementData);
          } catch (_) {
          }
        }
      } catch (fetchErr) {
        api.logger.warn(`[solana-trader] Bootstrap: live entitlement fetch failed for ${bootAgentId}: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
      }
      if (!entitlementData) {
        try {
          const cached = readJsonFile(path.join(stateDir, "entitlement-cache.json"));
          if (cached && typeof cached === "object") {
            entitlementData = { ...cached, source: "cache-fallback" };
          }
        } catch (_) {
        }
      }
      if (!entitlementData) {
        try {
          const agentState = readJsonFile(path.join(stateDir, `${bootAgentId}.json`));
          const s = agentState?.state;
          if (s && typeof s === "object" && "tier" in s) {
            entitlementData = { tier: s.tier, maxPositions: s.maxPositions, maxPositionSizeSol: s.maxPositionSizeSol, source: "durable-state-fallback", cachedAt: (/* @__PURE__ */ new Date()).toISOString() };
          }
        } catch (_) {
        }
      }
      if (!entitlementData) {
        entitlementData = { tier: "starter", maxPositions: 3, maxPositionSizeSol: 0.1, source: "conservative-default", cachedAt: (/* @__PURE__ */ new Date()).toISOString() };
        api.logger.warn(`[solana-trader] Bootstrap: no entitlement source available for ${bootAgentId}, injecting conservative Starter defaults`);
      }
      context.bootstrapFiles.push({
        name: "active-entitlements.json",
        path: "state/entitlement-cache.json",
        content: JSON.stringify(entitlementData, null, 2),
        source: "solana-trader:entitlements"
      });
      api.logger.info(`[solana-trader] Bootstrap: injected ${context.bootstrapFiles.length} files for agent ${bootAgentId}`);
    });
    api.registerHook("memory:flush", async (context) => {
      const flushAgentId = sanitizeAgentId(context.agentId || agentId);
      api.logger.info(`[solana-trader] Memory flush triggered for agent ${flushAgentId}`);
      try {
        const stateFile = path.join(stateDir, `${flushAgentId}.json`);
        const stateData = readJsonFile(stateFile);
        if (stateData?.state) {
          writeStateMd(flushAgentId, stateData.state);
          api.logger.info(`[solana-trader] Memory flush: STATE.md updated from persisted state for ${flushAgentId}`);
        } else {
          api.logger.info(`[solana-trader] Memory flush: no persisted state found for ${flushAgentId} \u2014 STATE.md not updated`);
        }
      } catch (err) {
        api.logger.warn(`[solana-trader] Memory flush: failed to write STATE.md for ${flushAgentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const now = /* @__PURE__ */ new Date();
        ensureDir(memoryDir);
        const logPath = getDailyLogPath(now);
        const timeStr = now.toISOString().slice(11, 19);
        const entry = `
### ${timeStr} \u2014 ${flushAgentId} [memory_flush]

Context compaction triggered. STATE.md synced from last persisted state. Decision log entries are server-persisted (no local buffer to flush).
`;
        if (!fs.existsSync(logPath)) {
          const dateStr = now.toISOString().slice(0, 10);
          const header = `# Daily Log \u2014 ${dateStr}

> Auto-generated by solana_daily_log. OpenClaw loads today + yesterday into context automatically.
`;
          fs.writeFileSync(logPath, header + entry, "utf-8");
        } else {
          fs.appendFileSync(logPath, entry, "utf-8");
        }
      } catch (err) {
        api.logger.warn(`[solana-trader] Memory flush: failed to write daily log for ${flushAgentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    api.registerService({
      id: "solana-trader-session",
      start: async () => {
        try {
          await sessionManager.initialize();
          const info = sessionManager.getSessionInfo();
          api.logger.info(
            `[solana-trader] Session active. Tier: ${info.tier}, Scopes: ${info.scopes.join(", ")}`
          );
        } catch (err) {
          api.logger.error(
            `[solana-trader] Session initialization failed: ${err instanceof Error ? err.message : String(err)}`
          );
          api.logger.error(
            "[solana-trader] Trading tools will fail until session is established. User should run on this machine: traderclaw login (after logout) or traderclaw setup / traderclaw signup for a new account. Wallet proof uses local signing only \u2014 private key never leaves this system."
          );
          return;
        }
        try {
          const healthz = await orchestratorRequest({
            baseUrl: orchestratorUrl,
            method: "GET",
            path: "/healthz",
            timeout: 5e3,
            accessToken: await sessionManager.getAccessToken()
          });
          api.logger.info(
            `[solana-trader] Orchestrator healthz OK at ${orchestratorUrl}`
          );
          if (healthz && typeof healthz === "object") {
            const h = healthz;
            api.logger.info(
              `[solana-trader] Mode: ${h.executionMode || "unknown"}, Upstream: ${h.upstreamConfigured ? "yes" : "no"}`
            );
          }
        } catch (err) {
          api.logger.warn(
            `[solana-trader] /healthz unreachable at ${orchestratorUrl}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        try {
          const status = await get("/api/system/status");
          api.logger.info(
            `[solana-trader] Connected to orchestrator (walletId: ${walletId})`
          );
          if (status && typeof status === "object") {
            api.logger.info(`[solana-trader] System status: ${JSON.stringify(status)}`);
          }
        } catch (err) {
          api.logger.warn(
            `[solana-trader] /api/system/status unreachable: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        try {
          const startupGate = await runStartupGate({ autoFixGateway: true, force: true });
          api.logger.info(
            `[solana-trader] Startup gate completed: ok=${startupGate.ok}, passed=${startupGate.summary.passed}, failed=${startupGate.summary.failed}`
          );
          if (!startupGate.ok) {
            api.logger.warn(
              `[solana-trader] Startup gate failures: ${JSON.stringify(startupGate.steps.filter((step) => !step.ok))}`
            );
          }
        } catch (err) {
          api.logger.warn(
            `[solana-trader] Startup gate run failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        try {
          const probe = await runForwardProbe({
            agentId: config.agentId || "main",
            source: "service_startup"
          });
          api.logger.info(
            `[solana-trader] Forward probe result: ${JSON.stringify(probe)}`
          );
        } catch (err) {
          api.logger.warn(
            `[solana-trader] Forward probe failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    });
    registerXTools(api, Type, config.xConfig, config.agentId || "main", "[solana-trader]");
    registerWebFetchTool(api, Type, "[solana-trader]");
    const xToolCount = config.xConfig?.ok ? 5 : 0;
    api.logger.info(
      `[solana-trader] Registered ${67 + xToolCount} tools (67 trading + ${xToolCount} X/Twitter) for walletId ${walletId} (session auth mode)`
    );
  }
};
var index_default = solanaTraderPlugin;
export {
  index_default as default
};
