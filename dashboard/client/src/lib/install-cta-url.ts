const DEFAULT_INSTALL_ORIGIN = 'https://install.traderclaw.ai';

/**
 * Header “Install TraderClaw” link. Set `VITE_TRADERCLAW_INSTALL_URL` in repo-root `.env`
 * (Vite `envDir`). Value may be a full URL or an origin; trimmed; empty falls back to default.
 */
export function traderClawInstallUrl(): string {
  const raw = import.meta.env.VITE_TRADERCLAW_INSTALL_URL;
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return DEFAULT_INSTALL_ORIGIN;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s.replace(/^\/+/, '')}`;
}
