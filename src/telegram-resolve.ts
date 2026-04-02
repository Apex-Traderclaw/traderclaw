/**
 * Resolve a Telegram destination to a numeric chat id for the orchestrator API.
 * - Numeric strings (optional leading -) are returned as-is.
 * - @username or username uses Bot API getChat (requires TELEGRAM_BOT_TOKEN or OPENCLAW_TELEGRAM_BOT_TOKEN).
 *
 * For private users, getChat(@username) only works after that user has started your bot at least once.
 * Public channels/supergroups with @username work when the bot can access the chat.
 */

export function looksLikeTelegramChatId(raw: string): boolean {
  const s = String(raw || "").trim();
  return s.length > 0 && /^-?\d+$/.test(s);
}

function normalizeUsernameHandle(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.startsWith("@") ? s : `@${s}`;
}

export async function resolveTelegramRecipientToChatId(opts: {
  botToken: string;
  raw: string;
}): Promise<string> {
  const trimmed = String(opts.raw || "").trim();
  if (!trimmed) {
    throw new Error("Telegram recipient is empty");
  }
  if (looksLikeTelegramChatId(trimmed)) {
    return trimmed;
  }

  const token = String(opts.botToken || "").trim();
  if (!token) {
    throw new Error(
      "Set TELEGRAM_BOT_TOKEN (or OPENCLAW_TELEGRAM_BOT_TOKEN) on the gateway to resolve @username to a chat id",
    );
  }

  const chatParam = normalizeUsernameHandle(trimmed);
  const url = `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatParam)}`;
  const res = await fetch(url);
  const data = (await res.json()) as {
    ok?: boolean;
    result?: { id?: number };
    description?: string;
  };

  if (!data.ok || data.result?.id == null) {
    throw new Error(
      data.description ||
        "Telegram getChat failed — for private chats the user must message your bot first; or use numeric chat id from @userinfobot",
    );
  }

  return String(data.result.id);
}
