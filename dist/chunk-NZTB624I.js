import {
  resolveIntelligenceDir
} from "./chunk-YBURTADE.js";

// src/intelligence-lab.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}
function readJsonFile(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}
function writeJsonFile(filePath, data) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
var IntelligenceLab = class {
  baseDir;
  constructor(workspaceRoot) {
    this.baseDir = resolveIntelligenceDir(workspaceRoot);
    ensureDir(this.baseDir);
  }
  candidatesFile() {
    return join(this.baseDir, "candidates.json");
  }
  sourceTrustFile() {
    return join(this.baseDir, "source-trust.json");
  }
  deployerTrustFile() {
    return join(this.baseDir, "deployer-trust.json");
  }
  modelsFile() {
    return join(this.baseDir, "models.json");
  }
  replayFile() {
    return join(this.baseDir, "last-replay.json");
  }
  writeCandidate(candidate) {
    const candidates = readJsonFile(this.candidatesFile(), []);
    const existing = candidates.findIndex((c) => c.id === candidate.id);
    const full = {
      ...candidate,
      createdAt: candidate.createdAt || (/* @__PURE__ */ new Date()).toISOString()
    };
    if (existing >= 0) {
      candidates[existing] = { ...candidates[existing], ...full };
    } else {
      candidates.push(full);
    }
    if (candidates.length > 5e3) {
      candidates.splice(0, candidates.length - 5e3);
    }
    writeJsonFile(this.candidatesFile(), candidates);
    return existing >= 0 ? candidates[existing] : full;
  }
  getCandidate(id) {
    const candidates = readJsonFile(this.candidatesFile(), []);
    return candidates.find((c) => c.id === id) || null;
  }
  getCandidates(filter) {
    let candidates = readJsonFile(this.candidatesFile(), []);
    if (filter?.outcome) {
      candidates = candidates.filter((c) => c.outcome === filter.outcome);
    }
    if (filter?.source) {
      candidates = candidates.filter((c) => c.source === filter.source);
    }
    const limit = filter?.limit || 50;
    return candidates.slice(-limit);
  }
  labelOutcome(id, outcome, pnlPct, holdingHours, notes) {
    const candidates = readJsonFile(this.candidatesFile(), []);
    const idx = candidates.findIndex((c) => c.id === id);
    if (idx < 0) return null;
    candidates[idx].outcome = outcome;
    candidates[idx].labeledAt = (/* @__PURE__ */ new Date()).toISOString();
    if (pnlPct !== void 0) candidates[idx].pnlPct = pnlPct;
    if (holdingHours !== void 0) candidates[idx].holdingHours = holdingHours;
    if (notes) candidates[idx].notes = notes;
    writeJsonFile(this.candidatesFile(), candidates);
    return candidates[idx];
  }
  candidateDelta(id, currentFeatures) {
    const candidate = this.getCandidate(id);
    if (!candidate) return { candidate: null, delta: {} };
    const delta = {};
    const allKeys = /* @__PURE__ */ new Set([...Object.keys(candidate.features), ...Object.keys(currentFeatures)]);
    for (const key of allKeys) {
      const was = candidate.features[key];
      const now = currentFeatures[key];
      if (was !== now) {
        delta[key] = { was: was ?? null, now: now ?? null };
      }
    }
    return { candidate, delta };
  }
  refreshSourceTrust(data) {
    const trusts = readJsonFile(this.sourceTrustFile(), []);
    const total = data.wins + data.losses + data.skips;
    const winRate = total > 0 ? data.wins / (data.wins + data.losses) : 0;
    const pnlComponent = Math.min(Math.max(data.avgPnlPct / 100, -1), 1) * 0.4;
    const winRateComponent = winRate * 0.4;
    const volumeComponent = Math.min(data.totalSignals / 100, 1) * 0.2;
    const score = Math.round((pnlComponent + winRateComponent + volumeComponent) * 100) / 100;
    const entry = {
      name: data.name,
      type: data.type,
      totalSignals: data.totalSignals,
      wins: data.wins,
      losses: data.losses,
      skips: data.skips,
      avgPnlPct: data.avgPnlPct,
      winRate: Math.round(winRate * 1e3) / 1e3,
      lastRefreshed: (/* @__PURE__ */ new Date()).toISOString(),
      score
    };
    const existing = trusts.findIndex((t) => t.name === data.name);
    if (existing >= 0) {
      trusts[existing] = entry;
    } else {
      trusts.push(entry);
    }
    writeJsonFile(this.sourceTrustFile(), trusts);
    return entry;
  }
  getSourceTrust(name) {
    const trusts = readJsonFile(this.sourceTrustFile(), []);
    if (name) {
      return trusts.find((t) => t.name === name) || trusts;
    }
    return trusts;
  }
  refreshDeployerTrust(data) {
    const trusts = readJsonFile(this.deployerTrustFile(), []);
    const rugRate = data.totalTokens > 0 ? data.rugs / data.totalTokens : 0;
    const survivalComponent = Math.min(data.avgSurvivalHours / 720, 1) * 0.3;
    const rugPenalty = rugRate * -0.5;
    const volumeComponent = Math.min(data.totalTokens / 50, 1) * 0.2;
    const trustScore = Math.round(Math.max(0, Math.min(1, 0.5 + survivalComponent + rugPenalty + volumeComponent)) * 100) / 100;
    const entry = {
      address: data.address,
      totalTokens: data.totalTokens,
      rugs: data.rugs,
      survivors: data.survivors,
      avgSurvivalHours: data.avgSurvivalHours,
      trustScore,
      lastRefreshed: (/* @__PURE__ */ new Date()).toISOString()
    };
    const existing = trusts.findIndex((t) => t.address === data.address);
    if (existing >= 0) {
      trusts[existing] = entry;
    } else {
      trusts.push(entry);
    }
    if (trusts.length > 1e3) {
      trusts.sort((a, b) => new Date(b.lastRefreshed).getTime() - new Date(a.lastRefreshed).getTime());
      trusts.splice(1e3);
    }
    writeJsonFile(this.deployerTrustFile(), trusts);
    return entry;
  }
  getDeployerTrust(address) {
    const trusts = readJsonFile(this.deployerTrustFile(), []);
    if (address) {
      return trusts.find((t) => t.address === address) || trusts;
    }
    return trusts;
  }
  getModels() {
    return readJsonFile(this.modelsFile(), []);
  }
  registerModel(model) {
    const models = readJsonFile(this.modelsFile(), []);
    const full = {
      ...model,
      createdAt: model.createdAt || (/* @__PURE__ */ new Date()).toISOString()
    };
    const existing = models.findIndex((m) => m.id === model.id);
    if (existing >= 0) {
      models[existing] = { ...models[existing], ...full };
    } else {
      models.push(full);
    }
    writeJsonFile(this.modelsFile(), models);
    return full;
  }
  scoreCandidate(modelId, features) {
    const models = readJsonFile(this.modelsFile(), []);
    const model = models.find((m) => m.id === modelId);
    if (!model) {
      return { score: 0.5, breakdown: { error: -1 } };
    }
    const breakdown = {};
    let totalWeight = 0;
    let weightedSum = 0;
    for (const [feature, weight] of Object.entries(model.weights)) {
      const value = features[feature];
      if (value === void 0) continue;
      let numValue;
      if (typeof value === "boolean") {
        numValue = value ? 1 : 0;
      } else if (typeof value === "number") {
        numValue = Math.min(Math.max(value, 0), 1);
      } else {
        continue;
      }
      const contribution = numValue * weight;
      breakdown[feature] = Math.round(contribution * 1e3) / 1e3;
      weightedSum += contribution;
      totalWeight += Math.abs(weight);
    }
    const score = totalWeight > 0 ? Math.round(Math.min(Math.max(weightedSum / totalWeight, 0), 1) * 1e3) / 1e3 : 0.5;
    return { score, breakdown };
  }
  promoteModel(challengerId) {
    const models = readJsonFile(this.modelsFile(), []);
    const challenger = models.find((m) => m.id === challengerId);
    if (!challenger) {
      return { promoted: false, newChampion: challengerId };
    }
    const oldChampion = models.find((m) => m.type === "champion");
    let oldChampionId;
    if (oldChampion) {
      oldChampionId = oldChampion.id;
      oldChampion.type = "challenger";
    }
    challenger.type = "champion";
    writeJsonFile(this.modelsFile(), models);
    return { promoted: true, oldChampion: oldChampionId, newChampion: challengerId };
  }
  runReplay(modelId) {
    const candidates = readJsonFile(this.candidatesFile(), []);
    const labeled = candidates.filter((c) => c.outcome && c.outcome !== "skip");
    if (labeled.length === 0) {
      return {
        modelId,
        candidateCount: 0,
        results: [],
        accuracy: 0,
        generatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    }
    const results = [];
    let correct = 0;
    for (const c of labeled) {
      const { score } = this.scoreCandidate(modelId, c.features);
      const predicted = score >= 0.5 ? "win" : "loss";
      const actual = c.outcome === "win" ? "win" : "loss";
      const isCorrect = predicted === actual;
      if (isCorrect) correct++;
      results.push({
        candidateId: c.id,
        predicted,
        actual,
        correct: isCorrect,
        score
      });
    }
    const result = {
      modelId,
      candidateCount: labeled.length,
      results,
      accuracy: Math.round(correct / labeled.length * 1e3) / 1e3,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    writeJsonFile(this.replayFile(), result);
    return result;
  }
  getLastReplay() {
    return readJsonFile(this.replayFile(), null);
  }
  generateEvaluation(modelId) {
    const candidates = readJsonFile(this.candidatesFile(), []);
    const labeled = candidates.filter((c) => c.outcome && c.outcome !== "skip");
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const c of labeled) {
      const { score } = this.scoreCandidate(modelId, c.features);
      const predicted = score >= 0.5;
      const actual = c.outcome === "win";
      if (predicted && actual) tp++;
      else if (predicted && !actual) fp++;
      else if (!predicted && !actual) tn++;
      else fn++;
    }
    const accuracy = labeled.length > 0 ? (tp + tn) / labeled.length : 0;
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    const buckets = [
      { min: 0, max: 0.2, label: "0.0-0.2" },
      { min: 0.2, max: 0.4, label: "0.2-0.4" },
      { min: 0.4, max: 0.6, label: "0.4-0.6" },
      { min: 0.6, max: 0.8, label: "0.6-0.8" },
      { min: 0.8, max: 1.01, label: "0.8-1.0" }
    ];
    const calibration = buckets.map((b) => {
      const inBucket = labeled.filter((c) => {
        const { score } = this.scoreCandidate(modelId, c.features);
        return score >= b.min && score < b.max;
      });
      const predicted = inBucket.length > 0 ? inBucket.reduce((sum, c) => sum + this.scoreCandidate(modelId, c.features).score, 0) / inBucket.length : 0;
      const actual = inBucket.length > 0 ? inBucket.filter((c) => c.outcome === "win").length / inBucket.length : 0;
      return { bucket: b.label, predicted: Math.round(predicted * 1e3) / 1e3, actual: Math.round(actual * 1e3) / 1e3 };
    });
    return {
      modelId,
      sampleSize: labeled.length,
      accuracy: Math.round(accuracy * 1e3) / 1e3,
      precision: Math.round(precision * 1e3) / 1e3,
      recall: Math.round(recall * 1e3) / 1e3,
      f1: Math.round(f1 * 1e3) / 1e3,
      confusionMatrix: { tp, fp, tn, fn },
      calibration,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  exportDataset(format = "json") {
    const candidates = readJsonFile(this.candidatesFile(), []);
    if (format === "csv") {
      if (candidates.length === 0) return "";
      const allFeatureKeys = /* @__PURE__ */ new Set();
      for (const c of candidates) {
        for (const k of Object.keys(c.features)) allFeatureKeys.add(k);
      }
      const featureKeys = [...allFeatureKeys].sort();
      const headers = ["id", "tokenAddress", "tokenSymbol", "source", "signalScore", "outcome", "pnlPct", ...featureKeys];
      const rows = candidates.map((c) => {
        const base = [c.id, c.tokenAddress, c.tokenSymbol, c.source, String(c.signalScore), c.outcome || "", String(c.pnlPct ?? "")];
        const features = featureKeys.map((k) => String(c.features[k] ?? ""));
        return [...base, ...features].join(",");
      });
      return [headers.join(","), ...rows].join("\n");
    }
    return JSON.stringify(candidates, null, 2);
  }
  contradictionCheck(claims) {
    const contradictions = [];
    const bullish = claims.filter((c) => /bullish|buy|moon|pump|accumulate|long/i.test(c.claim));
    const bearish = claims.filter((c) => /bearish|sell|dump|rug|short|exit/i.test(c.claim));
    for (const b of bullish) {
      for (const s of bearish) {
        if (b.source !== s.source) {
          const avgConfidence = (b.confidence + s.confidence) / 2;
          contradictions.push({
            claim1: b.claim,
            claim2: s.claim,
            source1: b.source,
            source2: s.source,
            severity: avgConfidence > 0.7 ? "high" : avgConfidence > 0.4 ? "medium" : "low"
          });
        }
      }
    }
    return { contradictions, totalClaims: claims.length };
  }
};

export {
  IntelligenceLab
};
