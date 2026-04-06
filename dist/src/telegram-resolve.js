// src/telegram-resolve.ts
function looksLikeTelegramChatId(raw) {
  const s = String(raw || "").trim();
  return s.length > 0 && /^-?\d+$/.test(s);
}
function normalizeUsernameHandle(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.startsWith("@") ? s : `@${s}`;
}
async function resolveTelegramRecipientToChatId(opts) {
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
      "Set TELEGRAM_BOT_TOKEN (or OPENCLAW_TELEGRAM_BOT_TOKEN) on the gateway to resolve @username to a chat id"
    );
  }
  const chatParam = normalizeUsernameHandle(trimmed);
  const url = `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatParam)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok || data.result?.id == null) {
    throw new Error(
      data.description || "Telegram getChat failed \u2014 for private chats the user must message your bot first; or use numeric chat id from @userinfobot"
    );
  }
  return String(data.result.id);
}
export {
  looksLikeTelegramChatId,
  resolveTelegramRecipientToChatId
};
