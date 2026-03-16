export interface AlphaSignal {
  sourceName: string;
  sourceType: "telegram" | "discord";
  externalRef?: string;
  isPremium: boolean;
  tokenAddress: string;
  tokenName: string;
  tokenSymbol: string;
  chain: string;
  marketCap?: number;
  price?: number;
  kind: "ca_drop" | "milestone" | "update" | "risk" | "exit";
  signalStage: "early" | "confirmation" | "milestone" | "risk" | "exit";
  summary: string;
  confidence: "low" | "medium" | "high";
  calledAgainCount: number;
  systemScore: number;
  ts: number;
  eventId?: string;
  _seen: boolean;
  _ingestedAt: number;
}

export interface SourceStats {
  name: string;
  type: string;
  signalCount: number;
  avgScore: number;
  totalScore: number;
}

export interface SignalFilterOpts {
  minScore?: number;
  chain?: string;
  kinds?: string[];
  unseen?: boolean;
}

const MAX_BUFFER_SIZE = 200;
const SEEN_EVENT_TTL_MS = 60 * 60 * 1000;
const MAX_SEEN_EVENTS = 500;

function dedupKey(signal: { sourceName: string; tokenAddress: string; kind: string; ts: number }): string {
  const minuteBucket = Math.floor(signal.ts / 60000);
  return `${signal.sourceName}|${signal.tokenAddress}|${signal.kind}|${minuteBucket}`;
}

export class AlphaBuffer {
  private signals: AlphaSignal[] = [];
  private dedupSet = new Set<string>();
  private seenEventIds = new Map<string, number>();
  private sourceStats = new Map<string, SourceStats>();
  private tokenIndex = new Map<string, number[]>();

  push(raw: Omit<AlphaSignal, "_seen" | "_ingestedAt">): boolean {
    if (raw.chain && raw.chain.toLowerCase() === "bsc") {
      return false;
    }

    const key = dedupKey(raw);
    if (this.dedupSet.has(key)) {
      return false;
    }

    const signal: AlphaSignal = {
      ...raw,
      systemScore: raw.systemScore ?? 0,
      _seen: false,
      _ingestedAt: Date.now(),
    };

    if (raw.eventId && this.seenEventIds.has(raw.eventId)) {
      signal._seen = true;
    }

    this.dedupSet.add(key);

    if (this.signals.length >= MAX_BUFFER_SIZE) {
      const evicted = this.signals.shift()!;
      const evictedKey = dedupKey(evicted);
      this.dedupSet.delete(evictedKey);
      this.decrementSourceStats(evicted);
      this.rebuildTokenIndex();
    }

    const idx = this.signals.length;
    this.signals.push(signal);

    const tokenIdxList = this.tokenIndex.get(signal.tokenAddress) || [];
    tokenIdxList.push(idx);
    this.tokenIndex.set(signal.tokenAddress, tokenIdxList);

    this.updateSourceStats(signal);

    return true;
  }

  getSignals(opts: SignalFilterOpts = {}): AlphaSignal[] {
    const { minScore, chain, kinds, unseen = true } = opts;
    const results: AlphaSignal[] = [];

    for (const signal of this.signals) {
      if (unseen && signal._seen) continue;
      if (minScore !== undefined && signal.systemScore < minScore) continue;
      if (chain && signal.chain.toLowerCase() !== chain.toLowerCase()) continue;
      if (kinds && kinds.length > 0 && !kinds.includes(signal.kind)) continue;
      results.push(signal);
    }

    if (unseen) {
      for (const signal of results) {
        signal._seen = true;
      }
    }

    return results;
  }

  getTokenHistory(tokenAddress: string): AlphaSignal[] {
    const indices = this.tokenIndex.get(tokenAddress);
    if (!indices) return [];
    return indices
      .filter((i) => i < this.signals.length)
      .map((i) => this.signals[i])
      .filter((s) => s.tokenAddress === tokenAddress);
  }

  getSourceStatsAll(): SourceStats[] {
    return Array.from(this.sourceStats.values());
  }

  markEventSeen(eventId: string): void {
    this.seenEventIds.set(eventId, Date.now());
    this.pruneSeenEvents();

    for (const signal of this.signals) {
      if (signal.eventId === eventId) {
        signal._seen = true;
      }
    }
  }

  hasSeenEvent(eventId: string): boolean {
    return this.seenEventIds.has(eventId);
  }

  getBufferSize(): number {
    return this.signals.length;
  }

  private updateSourceStats(signal: AlphaSignal): void {
    const existing = this.sourceStats.get(signal.sourceName);
    if (existing) {
      existing.signalCount++;
      existing.totalScore += signal.systemScore;
      existing.avgScore = existing.totalScore / existing.signalCount;
    } else {
      this.sourceStats.set(signal.sourceName, {
        name: signal.sourceName,
        type: signal.sourceType,
        signalCount: 1,
        avgScore: signal.systemScore,
        totalScore: signal.systemScore,
      });
    }
  }

  private decrementSourceStats(signal: AlphaSignal): void {
    const existing = this.sourceStats.get(signal.sourceName);
    if (!existing) return;
    existing.signalCount--;
    existing.totalScore -= signal.systemScore;
    if (existing.signalCount <= 0) {
      this.sourceStats.delete(signal.sourceName);
    } else {
      existing.avgScore = existing.totalScore / existing.signalCount;
    }
  }

  private rebuildTokenIndex(): void {
    this.tokenIndex.clear();
    for (let i = 0; i < this.signals.length; i++) {
      const addr = this.signals[i].tokenAddress;
      const list = this.tokenIndex.get(addr) || [];
      list.push(i);
      this.tokenIndex.set(addr, list);
    }
  }

  private pruneSeenEvents(): void {
    if (this.seenEventIds.size <= MAX_SEEN_EVENTS) return;
    const now = Date.now();
    for (const [id, timestamp] of this.seenEventIds) {
      if (now - timestamp > SEEN_EVENT_TTL_MS) {
        this.seenEventIds.delete(id);
      }
    }
    if (this.seenEventIds.size > MAX_SEEN_EVENTS) {
      const sorted = Array.from(this.seenEventIds.entries()).sort((a, b) => a[1] - b[1]);
      const toRemove = sorted.slice(0, sorted.length - MAX_SEEN_EVENTS);
      for (const [id] of toRemove) {
        this.seenEventIds.delete(id);
      }
    }
  }
}
