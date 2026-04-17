import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { resolveIntelligenceDir } from "./runtime-layout.js";

export interface Candidate {
  id: string;
  tokenAddress: string;
  tokenSymbol: string;
  chain: string;
  source: string;
  deployer?: string;
  marketCapAtEntry?: number;
  priceAtEntry?: number;
  signalScore: number;
  signalStage: string;
  features: Record<string, number | string | boolean>;
  createdAt: string;
  labeledAt?: string;
  outcome?: "win" | "loss" | "skip" | "dead_money";
  pnlPct?: number;
  holdingHours?: number;
  notes?: string;
}

export interface SourceTrust {
  name: string;
  type: string;
  totalSignals: number;
  wins: number;
  losses: number;
  skips: number;
  avgPnlPct: number;
  winRate: number;
  lastRefreshed: string;
  score: number;
}

export interface DeployerTrust {
  address: string;
  totalTokens: number;
  rugs: number;
  survivors: number;
  avgSurvivalHours: number;
  trustScore: number;
  lastRefreshed: string;
}

export interface ModelEntry {
  id: string;
  version: string;
  type: "champion" | "challenger";
  weights: Record<string, number>;
  createdAt: string;
  evaluatedAt?: string;
  accuracy?: number;
  precision?: number;
  recall?: number;
  f1?: number;
  sampleSize?: number;
}

export interface EvaluationResult {
  modelId: string;
  sampleSize: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  confusionMatrix: { tp: number; fp: number; tn: number; fn: number };
  calibration: { bucket: string; predicted: number; actual: number }[];
  generatedAt: string;
}

export interface ReplayResult {
  modelId: string;
  candidateCount: number;
  results: {
    candidateId: string;
    predicted: string;
    actual: string;
    correct: boolean;
    score: number;
  }[];
  accuracy: number;
  generatedAt: string;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export class IntelligenceLab {
  private baseDir: string;

  constructor(workspaceRoot: string) {
    this.baseDir = resolveIntelligenceDir(workspaceRoot);
    ensureDir(this.baseDir);
  }

  private candidatesFile(): string { return join(this.baseDir, "candidates.json"); }
  private sourceTrustFile(): string { return join(this.baseDir, "source-trust.json"); }
  private deployerTrustFile(): string { return join(this.baseDir, "deployer-trust.json"); }
  private modelsFile(): string { return join(this.baseDir, "models.json"); }
  private replayFile(): string { return join(this.baseDir, "last-replay.json"); }

  writeCandidate(candidate: Omit<Candidate, "createdAt"> & { createdAt?: string }): Candidate {
    const candidates = readJsonFile<Candidate[]>(this.candidatesFile(), []);
    const existing = candidates.findIndex(c => c.id === candidate.id);

    const full: Candidate = {
      ...candidate,
      createdAt: candidate.createdAt || new Date().toISOString(),
    };

    if (existing >= 0) {
      candidates[existing] = { ...candidates[existing], ...full };
    } else {
      candidates.push(full);
    }

    const MAX_CANDIDATES = 200;
    if (candidates.length > MAX_CANDIDATES) {
      const labeled = candidates.filter(c => c.outcome);
      const unlabeled = candidates.filter(c => !c.outcome);
      const keepUnlabeled = Math.max(0, MAX_CANDIDATES - labeled.length);
      const trimmed = [...labeled, ...unlabeled.slice(-keepUnlabeled)];
      candidates.length = 0;
      candidates.push(...trimmed);
    }

    writeJsonFile(this.candidatesFile(), candidates);
    return existing >= 0 ? candidates[existing] : full;
  }

  getCandidate(id: string): Candidate | null {
    const candidates = readJsonFile<Candidate[]>(this.candidatesFile(), []);
    return candidates.find(c => c.id === id) || null;
  }

  getCandidates(filter?: { outcome?: string; source?: string; limit?: number }): Candidate[] {
    let candidates = readJsonFile<Candidate[]>(this.candidatesFile(), []);

    if (filter?.outcome) {
      candidates = candidates.filter(c => c.outcome === filter.outcome);
    }
    if (filter?.source) {
      candidates = candidates.filter(c => c.source === filter.source);
    }

    const limit = filter?.limit || 50;
    return candidates.slice(-limit);
  }

  labelOutcome(id: string, outcome: Candidate["outcome"], pnlPct?: number, holdingHours?: number, notes?: string): Candidate | null {
    const candidates = readJsonFile<Candidate[]>(this.candidatesFile(), []);
    const idx = candidates.findIndex(c => c.id === id);
    if (idx < 0) return null;

    candidates[idx].outcome = outcome;
    candidates[idx].labeledAt = new Date().toISOString();
    if (pnlPct !== undefined) candidates[idx].pnlPct = pnlPct;
    if (holdingHours !== undefined) candidates[idx].holdingHours = holdingHours;
    if (notes) candidates[idx].notes = notes;

    writeJsonFile(this.candidatesFile(), candidates);
    return candidates[idx];
  }

  candidateDelta(id: string, currentFeatures: Record<string, number | string | boolean>): {
    candidate: Candidate | null;
    delta: Record<string, { was: unknown; now: unknown }>;
  } {
    const candidate = this.getCandidate(id);
    if (!candidate) return { candidate: null, delta: {} };

    const delta: Record<string, { was: unknown; now: unknown }> = {};
    const allKeys = new Set([...Object.keys(candidate.features), ...Object.keys(currentFeatures)]);

    for (const key of allKeys) {
      const was = candidate.features[key];
      const now = currentFeatures[key];
      if (was !== now) {
        delta[key] = { was: was ?? null, now: now ?? null };
      }
    }

    return { candidate, delta };
  }

  refreshSourceTrust(data: { name: string; type: string; wins: number; losses: number; skips: number; avgPnlPct: number; totalSignals: number }): SourceTrust {
    const trusts = readJsonFile<SourceTrust[]>(this.sourceTrustFile(), []);
    const total = data.wins + data.losses + data.skips;
    const winRate = total > 0 ? data.wins / (data.wins + data.losses) : 0;

    const pnlComponent = Math.min(Math.max(data.avgPnlPct / 100, -1), 1) * 0.4;
    const winRateComponent = winRate * 0.4;
    const volumeComponent = Math.min(data.totalSignals / 100, 1) * 0.2;
    const score = Math.round((pnlComponent + winRateComponent + volumeComponent) * 100) / 100;

    const entry: SourceTrust = {
      name: data.name,
      type: data.type,
      totalSignals: data.totalSignals,
      wins: data.wins,
      losses: data.losses,
      skips: data.skips,
      avgPnlPct: data.avgPnlPct,
      winRate: Math.round(winRate * 1000) / 1000,
      lastRefreshed: new Date().toISOString(),
      score,
    };

    const existing = trusts.findIndex(t => t.name === data.name);
    if (existing >= 0) {
      trusts[existing] = entry;
    } else {
      trusts.push(entry);
    }

    writeJsonFile(this.sourceTrustFile(), trusts);
    return entry;
  }

  getSourceTrust(name?: string): SourceTrust | SourceTrust[] {
    const trusts = readJsonFile<SourceTrust[]>(this.sourceTrustFile(), []);
    if (name) {
      return trusts.find(t => t.name === name) || trusts;
    }
    return trusts;
  }

  refreshDeployerTrust(data: { address: string; totalTokens: number; rugs: number; survivors: number; avgSurvivalHours: number }): DeployerTrust {
    const trusts = readJsonFile<DeployerTrust[]>(this.deployerTrustFile(), []);

    const rugRate = data.totalTokens > 0 ? data.rugs / data.totalTokens : 0;
    const survivalComponent = Math.min(data.avgSurvivalHours / 720, 1) * 0.3;
    const rugPenalty = rugRate * -0.5;
    const volumeComponent = Math.min(data.totalTokens / 50, 1) * 0.2;
    const trustScore = Math.round(Math.max(0, Math.min(1, 0.5 + survivalComponent + rugPenalty + volumeComponent)) * 100) / 100;

    const entry: DeployerTrust = {
      address: data.address,
      totalTokens: data.totalTokens,
      rugs: data.rugs,
      survivors: data.survivors,
      avgSurvivalHours: data.avgSurvivalHours,
      trustScore,
      lastRefreshed: new Date().toISOString(),
    };

    const existing = trusts.findIndex(t => t.address === data.address);
    if (existing >= 0) {
      trusts[existing] = entry;
    } else {
      trusts.push(entry);
    }

    if (trusts.length > 1000) {
      trusts.sort((a, b) => new Date(b.lastRefreshed).getTime() - new Date(a.lastRefreshed).getTime());
      trusts.splice(1000);
    }

    writeJsonFile(this.deployerTrustFile(), trusts);
    return entry;
  }

  getDeployerTrust(address?: string): DeployerTrust | DeployerTrust[] {
    const trusts = readJsonFile<DeployerTrust[]>(this.deployerTrustFile(), []);
    if (address) {
      return trusts.find(t => t.address === address) || trusts;
    }
    return trusts;
  }

  getModels(): ModelEntry[] {
    return readJsonFile<ModelEntry[]>(this.modelsFile(), []);
  }

  registerModel(model: Omit<ModelEntry, "createdAt"> & { createdAt?: string }): ModelEntry {
    const models = readJsonFile<ModelEntry[]>(this.modelsFile(), []);
    const full: ModelEntry = {
      ...model,
      createdAt: model.createdAt || new Date().toISOString(),
    };

    const existing = models.findIndex(m => m.id === model.id);
    if (existing >= 0) {
      models[existing] = { ...models[existing], ...full };
    } else {
      models.push(full);
    }

    writeJsonFile(this.modelsFile(), models);
    return full;
  }

  scoreCandidate(modelId: string, features: Record<string, number | string | boolean>): { score: number; breakdown: Record<string, number> } {
    const models = readJsonFile<ModelEntry[]>(this.modelsFile(), []);
    const model = models.find(m => m.id === modelId);
    if (!model) {
      return { score: 0.5, breakdown: { error: -1 } };
    }

    const breakdown: Record<string, number> = {};
    let totalWeight = 0;
    let weightedSum = 0;

    for (const [feature, weight] of Object.entries(model.weights)) {
      const value = features[feature];
      if (value === undefined) continue;

      let numValue: number;
      if (typeof value === "boolean") {
        numValue = value ? 1 : 0;
      } else if (typeof value === "number") {
        numValue = Math.min(Math.max(value, 0), 1);
      } else {
        continue;
      }

      const contribution = numValue * weight;
      breakdown[feature] = Math.round(contribution * 1000) / 1000;
      weightedSum += contribution;
      totalWeight += Math.abs(weight);
    }

    const score = totalWeight > 0
      ? Math.round(Math.min(Math.max(weightedSum / totalWeight, 0), 1) * 1000) / 1000
      : 0.5;

    return { score, breakdown };
  }

  promoteModel(challengerId: string): { promoted: boolean; oldChampion?: string; newChampion: string } {
    const models = readJsonFile<ModelEntry[]>(this.modelsFile(), []);
    const challenger = models.find(m => m.id === challengerId);
    if (!challenger) {
      return { promoted: false, newChampion: challengerId };
    }

    const oldChampion = models.find(m => m.type === "champion");
    let oldChampionId: string | undefined;

    if (oldChampion) {
      oldChampionId = oldChampion.id;
      oldChampion.type = "challenger";
    }

    challenger.type = "champion";
    writeJsonFile(this.modelsFile(), models);

    return { promoted: true, oldChampion: oldChampionId, newChampion: challengerId };
  }

  runReplay(modelId: string): ReplayResult {
    const candidates = readJsonFile<Candidate[]>(this.candidatesFile(), []);
    const labeled = candidates.filter(c => c.outcome && c.outcome !== "skip");

    if (labeled.length === 0) {
      return {
        modelId,
        candidateCount: 0,
        results: [],
        accuracy: 0,
        generatedAt: new Date().toISOString(),
      };
    }

    const results: ReplayResult["results"] = [];
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
        score,
      });
    }

    const result: ReplayResult = {
      modelId,
      candidateCount: labeled.length,
      results,
      accuracy: Math.round((correct / labeled.length) * 1000) / 1000,
      generatedAt: new Date().toISOString(),
    };

    writeJsonFile(this.replayFile(), result);
    return result;
  }

  getLastReplay(): ReplayResult | null {
    return readJsonFile<ReplayResult | null>(this.replayFile(), null);
  }

  generateEvaluation(modelId: string): EvaluationResult {
    const candidates = readJsonFile<Candidate[]>(this.candidatesFile(), []);
    const labeled = candidates.filter(c => c.outcome && c.outcome !== "skip");

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
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
    const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
    const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    const buckets = [
      { min: 0, max: 0.2, label: "0.0-0.2" },
      { min: 0.2, max: 0.4, label: "0.2-0.4" },
      { min: 0.4, max: 0.6, label: "0.4-0.6" },
      { min: 0.6, max: 0.8, label: "0.6-0.8" },
      { min: 0.8, max: 1.01, label: "0.8-1.0" },
    ];

    const calibration = buckets.map(b => {
      const inBucket = labeled.filter(c => {
        const { score } = this.scoreCandidate(modelId, c.features);
        return score >= b.min && score < b.max;
      });
      const predicted = inBucket.length > 0
        ? inBucket.reduce((sum, c) => sum + this.scoreCandidate(modelId, c.features).score, 0) / inBucket.length
        : 0;
      const actual = inBucket.length > 0
        ? inBucket.filter(c => c.outcome === "win").length / inBucket.length
        : 0;
      return { bucket: b.label, predicted: Math.round(predicted * 1000) / 1000, actual: Math.round(actual * 1000) / 1000 };
    });

    return {
      modelId,
      sampleSize: labeled.length,
      accuracy: Math.round(accuracy * 1000) / 1000,
      precision: Math.round(precision * 1000) / 1000,
      recall: Math.round(recall * 1000) / 1000,
      f1: Math.round(f1 * 1000) / 1000,
      confusionMatrix: { tp, fp, tn, fn },
      calibration,
      generatedAt: new Date().toISOString(),
    };
  }

  exportDataset(format: "json" | "csv" = "json"): string {
    const candidates = readJsonFile<Candidate[]>(this.candidatesFile(), []);

    if (format === "csv") {
      if (candidates.length === 0) return "";
      const allFeatureKeys = new Set<string>();
      for (const c of candidates) {
        for (const k of Object.keys(c.features)) allFeatureKeys.add(k);
      }
      const featureKeys = [...allFeatureKeys].sort();
      const headers = ["id", "tokenAddress", "tokenSymbol", "source", "signalScore", "outcome", "pnlPct", ...featureKeys];
      const rows = candidates.map(c => {
        const base = [c.id, c.tokenAddress, c.tokenSymbol, c.source, String(c.signalScore), c.outcome || "", String(c.pnlPct ?? "")];
        const features = featureKeys.map(k => String(c.features[k] ?? ""));
        return [...base, ...features].join(",");
      });
      return [headers.join(","), ...rows].join("\n");
    }

    return JSON.stringify(candidates, null, 2);
  }

  contradictionCheck(claims: { claim: string; source: string; confidence: number }[]): {
    contradictions: { claim1: string; claim2: string; source1: string; source2: string; severity: string }[];
    totalClaims: number;
  } {
    const contradictions: { claim1: string; claim2: string; source1: string; source2: string; severity: string }[] = [];

    const bullish = claims.filter(c => /bullish|buy|moon|pump|accumulate|long/i.test(c.claim));
    const bearish = claims.filter(c => /bearish|sell|dump|rug|short|exit/i.test(c.claim));

    for (const b of bullish) {
      for (const s of bearish) {
        if (b.source !== s.source) {
          const avgConfidence = (b.confidence + s.confidence) / 2;
          contradictions.push({
            claim1: b.claim,
            claim2: s.claim,
            source1: b.source,
            source2: s.source,
            severity: avgConfidence > 0.7 ? "high" : avgConfidence > 0.4 ? "medium" : "low",
          });
        }
      }
    }

    return { contradictions, totalClaims: claims.length };
  }
}
