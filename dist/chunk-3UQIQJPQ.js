// src/alpha-buffer.ts
var MAX_BUFFER_SIZE = 200;
var SEEN_EVENT_TTL_MS = 60 * 60 * 1e3;
var MAX_SEEN_EVENTS = 500;
function dedupKey(signal) {
  const minuteBucket = Math.floor(signal.ts / 6e4);
  return `${signal.sourceName}|${signal.tokenAddress}|${signal.kind}|${minuteBucket}`;
}
var AlphaBuffer = class {
  signals = [];
  dedupSet = /* @__PURE__ */ new Set();
  seenEventIds = /* @__PURE__ */ new Map();
  sourceStats = /* @__PURE__ */ new Map();
  tokenIndex = /* @__PURE__ */ new Map();
  push(raw) {
    if (raw.chain && raw.chain.toLowerCase() === "bsc") {
      return false;
    }
    const key = dedupKey(raw);
    if (this.dedupSet.has(key)) {
      return false;
    }
    const signal = {
      ...raw,
      systemScore: raw.systemScore ?? 0,
      _seen: false,
      _ingestedAt: Date.now()
    };
    if (raw.eventId && this.seenEventIds.has(raw.eventId)) {
      signal._seen = true;
    }
    this.dedupSet.add(key);
    if (this.signals.length >= MAX_BUFFER_SIZE) {
      const evicted = this.signals.shift();
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
  getSignals(opts = {}) {
    const { minScore, chain, kinds, unseen = true } = opts;
    const results = [];
    for (const signal of this.signals) {
      if (unseen && signal._seen) continue;
      if (minScore !== void 0 && signal.systemScore < minScore) continue;
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
  getTokenHistory(tokenAddress) {
    const indices = this.tokenIndex.get(tokenAddress);
    if (!indices) return [];
    return indices.filter((i) => i < this.signals.length).map((i) => this.signals[i]).filter((s) => s.tokenAddress === tokenAddress);
  }
  getSourceStatsAll() {
    return Array.from(this.sourceStats.values());
  }
  markEventSeen(eventId) {
    this.seenEventIds.set(eventId, Date.now());
    this.pruneSeenEvents();
    for (const signal of this.signals) {
      if (signal.eventId === eventId) {
        signal._seen = true;
      }
    }
  }
  hasSeenEvent(eventId) {
    return this.seenEventIds.has(eventId);
  }
  getBufferSize() {
    return this.signals.length;
  }
  updateSourceStats(signal) {
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
        totalScore: signal.systemScore
      });
    }
  }
  decrementSourceStats(signal) {
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
  rebuildTokenIndex() {
    this.tokenIndex.clear();
    for (let i = 0; i < this.signals.length; i++) {
      const addr = this.signals[i].tokenAddress;
      const list = this.tokenIndex.get(addr) || [];
      list.push(i);
      this.tokenIndex.set(addr, list);
    }
  }
  pruneSeenEvents() {
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
};

export {
  AlphaBuffer
};
