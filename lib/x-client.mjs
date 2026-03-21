import { createHmac, randomBytes } from "crypto";

const X_API_BASE = "https://api.twitter.com/2";
const MAX_TWEET_LENGTH = 280;

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function generateNonce() {
  return randomBytes(16).toString("hex");
}

function generateTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

function buildBaseString(method, url, params) {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
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
    ...queryParams,
  };

  const signature = signRequest(
    method,
    url,
    oauthParams,
    credentials.consumerSecret,
    credentials.accessTokenSecret,
  );

  oauthParams.oauth_signature = signature;

  const headerParts = Object.keys(oauthParams)
    .filter((k) => k.startsWith("oauth_"))
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(", ");

  return `OAuth ${headerParts}`;
}

async function xApiFetch(method, endpoint, credentials, { body = null, queryParams = {} } = {}) {
  const url = `${X_API_BASE}${endpoint}`;

  const queryString = Object.keys(queryParams).length > 0
    ? "?" + Object.entries(queryParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : "";

  const fullUrl = `${url}${queryString}`;

  const authHeader = buildAuthHeader(method, url, credentials, method === "GET" ? queryParams : {});

  const headers = {
    Authorization: authHeader,
    "User-Agent": "TraderClaw-Team/1.0",
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
      const resetTime = rateLimitReset ? new Date(parseInt(rateLimitReset) * 1000).toISOString() : "unknown";
      return {
        ok: false,
        error: `Rate limited. Resets at ${resetTime}.`,
        status: 429,
        resetAt: resetTime,
        data: responseData,
      };
    }

    if (response.status === 401) {
      return {
        ok: false,
        error: "Authentication failed. Check your X API credentials (consumer key/secret and access token/secret). Ensure the app has Read+Write permissions and tokens were regenerated after permission change.",
        status: 401,
        data: responseData,
      };
    }

    if (response.status === 403) {
      return {
        ok: false,
        error: "Forbidden. Your X API tier may not support this endpoint. Free tier is write-only (posting). Upgrade to Basic ($200/mo) or pay-as-you-go for read access (mentions, search).",
        status: 403,
        data: responseData,
      };
    }

    return {
      ok: false,
      error: `X API error ${response.status}: ${responseData?.detail || responseData?.title || responseText.slice(0, 200)}`,
      status: response.status,
      data: responseData,
    };
  }

  return {
    ok: true,
    status: response.status,
    data: responseData,
    rateLimitRemaining: rateLimitRemaining ? parseInt(rateLimitRemaining) : undefined,
  };
}

export function validateTweetText(text) {
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

export async function postTweet(credentials, text) {
  const validation = validateTweetText(text);
  if (!validation.valid) return { ok: false, error: validation.error };

  const result = await xApiFetch("POST", "/tweets", credentials, {
    body: { text: validation.text },
  });

  if (result.ok && result.data?.data?.id) {
    const tweetId = result.data.data.id;
    const username = credentials.username || "unknown";
    return {
      ok: true,
      tweetId,
      tweetUrl: `https://x.com/${username}/status/${tweetId}`,
      text: validation.text,
    };
  }

  return result;
}

export async function replyToTweet(credentials, tweetId, text) {
  const validation = validateTweetText(text);
  if (!validation.valid) return { ok: false, error: validation.error };

  if (!tweetId || typeof tweetId !== "string") {
    return { ok: false, error: "tweetId is required to reply." };
  }

  const result = await xApiFetch("POST", "/tweets", credentials, {
    body: {
      text: validation.text,
      reply: { in_reply_to_tweet_id: tweetId },
    },
  });

  if (result.ok && result.data?.data?.id) {
    const replyId = result.data.data.id;
    const username = credentials.username || "unknown";
    return {
      ok: true,
      replyId,
      replyUrl: `https://x.com/${username}/status/${replyId}`,
      inReplyTo: tweetId,
      text: validation.text,
    };
  }

  return result;
}

export async function readMentions(credentials, { maxResults = 10, sinceId = null, paginationToken = null } = {}) {
  if (!credentials.userId) {
    return { ok: false, error: "userId is required to read mentions. Set it in the agent's X profile config." };
  }

  const queryParams = {
    max_results: String(Math.min(Math.max(maxResults, 5), 100)),
    "tweet.fields": "created_at,author_id,conversation_id,in_reply_to_user_id,text",
    expansions: "author_id",
    "user.fields": "username,name",
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
        conversationId: t.conversation_id,
      })),
      nextToken: result.data?.meta?.next_token || null,
      resultCount: result.data?.meta?.result_count || 0,
    };
  }

  return result;
}

export async function searchTweets(credentials, query, { maxResults = 10, sinceId = null, paginationToken = null } = {}) {
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return { ok: false, error: "Search query is required." };
  }

  const queryParams = {
    query: query.trim(),
    max_results: String(Math.min(Math.max(maxResults, 10), 100)),
    "tweet.fields": "created_at,author_id,public_metrics,conversation_id,text",
    expansions: "author_id",
    "user.fields": "username,name,public_metrics",
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
        conversationId: t.conversation_id,
      })),
      nextToken: result.data?.meta?.next_token || null,
      resultCount: result.data?.meta?.result_count || 0,
    };
  }

  return result;
}

export async function getThread(credentials, tweetId, { maxResults = 20 } = {}) {
  if (!tweetId || typeof tweetId !== "string") {
    return { ok: false, error: "tweetId is required to get a thread." };
  }

  const queryParams = {
    query: `conversation_id:${tweetId}`,
    max_results: String(Math.min(Math.max(maxResults, 10), 100)),
    "tweet.fields": "created_at,author_id,in_reply_to_user_id,conversation_id,text,public_metrics",
    expansions: "author_id",
    "user.fields": "username,name",
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
        metrics: t.public_metrics || {},
      })),
      resultCount: tweets.length,
    };
  }

  return result;
}

export async function verifyCredentials(credentials) {
  const result = await xApiFetch("GET", "/users/me", credentials, {
    queryParams: { "user.fields": "id,username,name,created_at,public_metrics" },
  });

  if (result.ok && result.data?.data) {
    return {
      ok: true,
      user: result.data.data,
    };
  }

  return result;
}

export function resolveCredentials(pluginConfig, agentId) {
  const x = pluginConfig?.x;
  if (!x) {
    return { ok: false, error: "X/Twitter configuration missing. Set 'x.consumerKey', 'x.consumerSecret', and 'x.profiles.<agentId>' in plugin config." };
  }

  const consumerKey = x.consumerKey || process.env.X_CONSUMER_KEY;
  const consumerSecret = x.consumerSecret || process.env.X_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    return { ok: false, error: "X App credentials missing. Set 'x.consumerKey' and 'x.consumerSecret' in plugin config, or set X_CONSUMER_KEY / X_CONSUMER_SECRET env vars." };
  }

  const profile = x.profiles?.[agentId] || x.profiles?.["default"];
  if (!profile) {
    return { ok: false, error: `No X profile configured for agent '${agentId}'. Add 'x.profiles.${agentId}' (or 'x.profiles.default') with accessToken and accessTokenSecret.` };
  }

  const envPrefix = `X_ACCESS_TOKEN_${agentId.toUpperCase().replace(/-/g, "_")}`;
  const accessToken = profile.accessToken || process.env[envPrefix];
  const accessTokenSecret = profile.accessTokenSecret || process.env[`${envPrefix}_SECRET`];

  if (!accessToken || !accessTokenSecret) {
    return { ok: false, error: `X access tokens missing for agent '${agentId}'. Set accessToken and accessTokenSecret in the profile config.` };
  }

  return {
    ok: true,
    credentials: {
      consumerKey,
      consumerSecret,
      accessToken,
      accessTokenSecret,
      userId: profile.userId || null,
      username: profile.username || agentId,
    },
  };
}
