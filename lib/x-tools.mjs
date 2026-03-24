import { readMentions, searchTweets, getThread, postTweet, replyToTweet } from "./x-client.mjs";

export function parseXConfig(obj) {
  const xRaw = (obj?.x && typeof obj.x === "object" && !Array.isArray(obj.x))
    ? obj.x
    : {};

  const consumerKey = typeof xRaw.consumerKey === "string" ? xRaw.consumerKey : (process.env.X_CONSUMER_KEY || "");
  const consumerSecret = typeof xRaw.consumerSecret === "string" ? xRaw.consumerSecret : (process.env.X_CONSUMER_SECRET || "");
  const profiles = {};

  if (xRaw.profiles && typeof xRaw.profiles === "object" && !Array.isArray(xRaw.profiles)) {
    for (const [key, val] of Object.entries(xRaw.profiles)) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const envPrefix = `X_ACCESS_TOKEN_${key.toUpperCase().replace(/-/g, "_")}`;
        const accessToken = typeof val.accessToken === "string" ? val.accessToken : (process.env[envPrefix] || "");
        const accessTokenSecret = typeof val.accessTokenSecret === "string" ? val.accessTokenSecret : (process.env[`${envPrefix}_SECRET`] || "");
        if (accessToken && accessTokenSecret) {
          profiles[key] = {
            accessToken,
            accessTokenSecret,
            userId: typeof val.userId === "string" ? val.userId : undefined,
            username: typeof val.username === "string" ? val.username : undefined,
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

export function resolveAgentCredentials(xConfig, callerAgentId, requestedAgentId, fallbackAgentId) {
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
      username: profile.username || agentId,
    },
  };
}

export function registerXReadTools(api, Type, xConfig, fallbackAgentId, logPrefix, options) {
  const checkPermission = options?.checkPermission || null;

  const json = (data) => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  });

  const wrapExecute = (toolName, fn) =>
    async (toolCallId, params) => {
      try {
        if (checkPermission) {
          const callingAgentId = (params?._agentId) || fallbackAgentId;
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
    parameters: Type.Object({
      query: Type.String({ description: "Search query. Examples: '$BONK sentiment', 'solana memecoin', 'from:elonmusk crypto', '#SOL', 'conversation_id:123'" }),
      maxResults: Type.Optional(Type.Number({ description: "Number of results (10-100, default: 10)" })),
      sinceId: Type.Optional(Type.String({ description: "Only return tweets newer than this tweet ID" })),
      paginationToken: Type.Optional(Type.String({ description: "Pagination token from a previous response" })),
      agentId: Type.Optional(Type.String({ description: "Override agent ID (default: caller's agent identity)" })),
    }),
    execute: wrapExecute("x_search_tweets", async (_id, params) => {
      const callerAgentId = params._agentId;
      const creds = resolveAgentCredentials(xConfig, callerAgentId, params.agentId, fallbackAgentId);
      if (!creds.ok) return { error: creds.error };
      return searchTweets(creds.credentials, params.query, {
        maxResults: params.maxResults,
        sinceId: params.sinceId,
        paginationToken: params.paginationToken,
      });
    }),
  });

  api.registerTool({
    name: "x_read_mentions",
    description: "Read recent @mentions of the configured X profile. Use for monitoring community reactions and engagement. Requires pay-as-you-go or Basic tier X API access.",
    parameters: Type.Object({
      maxResults: Type.Optional(Type.Number({ description: "Number of mentions to return (5-100, default: 10)" })),
      sinceId: Type.Optional(Type.String({ description: "Only return mentions newer than this tweet ID" })),
      paginationToken: Type.Optional(Type.String({ description: "Pagination token from a previous response" })),
      agentId: Type.Optional(Type.String({ description: "Override agent ID (default: caller's agent identity)" })),
    }),
    execute: wrapExecute("x_read_mentions", async (_id, params) => {
      const callerAgentId = params._agentId;
      const creds = resolveAgentCredentials(xConfig, callerAgentId, params.agentId, fallbackAgentId);
      if (!creds.ok) return { error: creds.error };
      return readMentions(creds.credentials, {
        maxResults: params.maxResults,
        sinceId: params.sinceId,
        paginationToken: params.paginationToken,
      });
    }),
  });

  api.registerTool({
    name: "x_get_thread",
    description: "Read a full conversation thread on X/Twitter by tweet ID. Use for understanding context around viral posts or influencer discussions. Requires pay-as-you-go or Basic tier X API access.",
    parameters: Type.Object({
      tweetId: Type.String({ description: "The tweet ID to get the conversation thread for" }),
      maxResults: Type.Optional(Type.Number({ description: "Max replies to return (10-100, default: 20)" })),
      agentId: Type.Optional(Type.String({ description: "Override agent ID (default: caller's agent identity)" })),
    }),
    execute: wrapExecute("x_get_thread", async (_id, params) => {
      const callerAgentId = params._agentId;
      const creds = resolveAgentCredentials(xConfig, callerAgentId, params.agentId, fallbackAgentId);
      if (!creds.ok) return { error: creds.error };
      return getThread(creds.credentials, params.tweetId, {
        maxResults: params.maxResults,
      });
    }),
  });

  api.logger.info(`${logPrefix} Registered 3 X/Twitter read tools (search, mentions, threads). Profiles: ${xConfig.ok ? Object.keys(xConfig.profiles).join(", ") || "none" : "unconfigured"}`);
}

/** Registers read tools (search, mentions, threads) plus post and reply for team / journal workflows. */
export function registerXTools(api, Type, xConfig, fallbackAgentId, logPrefix, options) {
  registerXReadTools(api, Type, xConfig, fallbackAgentId, logPrefix, options);

  const checkPermission = options?.checkPermission || null;

  const json = (data) => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  });

  const wrapExecute = (toolName, fn) =>
    async (toolCallId, params) => {
      try {
        if (checkPermission) {
          const callingAgentId = (params?._agentId) || fallbackAgentId;
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
    description:
      "Post a new tweet from the configured X profile (max 280 characters). Use for trade journaling, announcements, and community updates. Requires X app with Read + Write and OAuth 1.0a user tokens.",
    parameters: Type.Object({
      text: Type.String({ description: "Tweet body (plain text, max 280 chars after trim)" }),
      agentId: Type.Optional(Type.String({ description: "Override agent ID (default: caller's agent identity)" })),
    }),
    execute: wrapExecute("x_post_tweet", async (_id, params) => {
      const callerAgentId = params._agentId;
      const creds = resolveAgentCredentials(xConfig, callerAgentId, params.agentId, fallbackAgentId);
      if (!creds.ok) return { error: creds.error };
      return postTweet(creds.credentials, params.text);
    }),
  });

  api.registerTool({
    name: "x_reply_tweet",
    description:
      "Reply to an existing tweet by ID from the configured X profile. Use for threading journal entries or engaging with mentions. Requires Read + Write OAuth 1.0a user tokens.",
    parameters: Type.Object({
      tweetId: Type.String({ description: "Target tweet ID to reply to" }),
      text: Type.String({ description: "Reply body (plain text, max 280 chars after trim)" }),
      agentId: Type.Optional(Type.String({ description: "Override agent ID (default: caller's agent identity)" })),
    }),
    execute: wrapExecute("x_reply_tweet", async (_id, params) => {
      const callerAgentId = params._agentId;
      const creds = resolveAgentCredentials(xConfig, callerAgentId, params.agentId, fallbackAgentId);
      if (!creds.ok) return { error: creds.error };
      return replyToTweet(creds.credentials, params.tweetId, params.text);
    }),
  });

  api.logger.info(
    `${logPrefix} Registered 5 X/Twitter tools (3 read + post + reply). Profiles: ${xConfig.ok ? Object.keys(xConfig.profiles).join(", ") || "none" : "unconfigured"}`,
  );
}
