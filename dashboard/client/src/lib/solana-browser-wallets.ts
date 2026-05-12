import bs58 from "bs58";

/** Minimal Solana browser wallet surface for UTF-8 off-chain signing (Phantom, Solflare, Backpack-style). */
export type InjectedSolanaProvider = {
  connect?: (opts?: { onlyIfTrusted?: boolean }) => Promise<unknown>;
  disconnect?: () => Promise<void>;
  publicKey?: { toBytes?: () => Uint8Array; toBase58?: () => string } | null;
  signMessage?: (message: Uint8Array, encoding?: string) => Promise<{ signature: Uint8Array }>;
};

export type DetectedSolanaWallet = {
  id: string;
  label: string;
  provider: InjectedSolanaProvider;
};

function walletLikeToBase58(walletPublicKeyLike: unknown): string {
  if (typeof walletPublicKeyLike === "string") return walletPublicKeyLike.trim();
  const o = walletPublicKeyLike as { toBase58?: () => string; toBytes?: () => Uint8Array } | null | undefined;
  if (o && typeof o.toBase58 === "function") {
    const s = o.toBase58();
    if (s) return String(s).trim();
  }
  if (o && typeof o.toBytes === "function") {
    try {
      return bs58.encode(new Uint8Array(o.toBytes()));
    } catch {
      /* ignore */
    }
  }
  throw new Error("Could not read wallet public key");
}

/**
 * Finds injectors that expose `signMessage` (Phantom, Solflare, Backpack, …).
 */
export function detectBrowserSolanaWallets(): DetectedSolanaWallet[] {
  if (typeof window === "undefined") return [];
  const w = window as Window & {
    phantom?: { solana?: InjectedSolanaProvider };
    solflare?: InjectedSolanaProvider;
    solana?: InjectedSolanaProvider;
    backpack?: { solana?: InjectedSolanaProvider };
  };
  const out: DetectedSolanaWallet[] = [];
  const seen = new WeakSet<object>();

  const add = (id: string, label: string, p: InjectedSolanaProvider | null | undefined) => {
    if (!p?.signMessage) return;
    if (seen.has(p)) return;
    seen.add(p);
    out.push({ id, label, provider: p });
  };

  add("phantom", "Phantom", w.phantom?.solana);
  add("solflare", "Solflare", w.solflare && w.solflare !== w.phantom?.solana ? w.solflare : undefined);
  add("backpack", "Backpack", w.backpack?.solana);
  if (
    w.solana?.signMessage &&
    w.solana !== w.phantom?.solana &&
    w.solana !== w.solflare &&
    w.solana !== w.backpack?.solana
  ) {
    add("injected_solana", "Browser wallet", w.solana);
  }
  return out;
}

export async function ensureProviderConnected(provider: InjectedSolanaProvider): Promise<void> {
  if (provider.publicKey) return;
  if (typeof provider.connect === "function") {
    await provider.connect();
  }
}

export function readSignerPublicKeyBase58(provider: InjectedSolanaProvider): string {
  const pk = provider.publicKey;
  if (!pk) {
    throw new Error("Wallet is not connected");
  }
  return walletLikeToBase58(pk);
}

/**
 * Sign the exact UTF-8 challenge returned by POST /api/access/runtime-hold-wallet/challenge (ed25519, base58 for API body).
 */
export async function signRuntimeHoldChallenge(provider: InjectedSolanaProvider, challengeUtf8: string) {
  if (!provider.signMessage) {
    throw new Error("Wallet cannot sign messages");
  }
  await ensureProviderConnected(provider);
  const message = new TextEncoder().encode(challengeUtf8);
  const res = await provider.signMessage(message, "utf8");
  const sig = res.signature;
  const signatureBytes = sig instanceof Uint8Array ? sig : new Uint8Array(sig as unknown as ArrayBuffer);
  let signerPk: string;
  try {
    signerPk = readSignerPublicKeyBase58(provider);
  } catch {
    signerPk = "";
  }
  return {
    walletSignature: bs58.encode(signatureBytes),
    signerPublicKey: signerPk,
  };
}
