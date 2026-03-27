export interface ScrubResult {
  clean: string;
  injectionDetected: boolean;
  threats: string[];
  extractedAddresses: string[];
  extractedUrls: string[];
  extractedTickers: string[];
}

const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, label: "instruction_override" },
  { pattern: /forget\s+(everything|all|your)\s+(you\s+)?(know|instructions|rules)/i, label: "instruction_override" },
  { pattern: /you\s+are\s+now\s+(a|an)\s+/i, label: "role_hijack" },
  { pattern: /act\s+as\s+(if\s+)?(you\s+)?(are|were)\s+/i, label: "role_hijack" },
  { pattern: /new\s+system\s+prompt/i, label: "system_prompt_inject" },
  { pattern: /\[system\]/i, label: "system_prompt_inject" },
  { pattern: /\[INST\]/i, label: "system_prompt_inject" },
  { pattern: /<\|im_start\|>/i, label: "delimiter_inject" },
  { pattern: /<\|endoftext\|>/i, label: "delimiter_inject" },
  { pattern: /```system/i, label: "codeblock_inject" },
  { pattern: /do\s+not\s+follow\s+(your\s+)?(safety|trading|risk)\s+(rules|guidelines)/i, label: "safety_bypass" },
  { pattern: /override\s+(kill\s*switch|safety|limits|rules)/i, label: "safety_bypass" },
  { pattern: /disable\s+(kill\s*switch|safety|limits)/i, label: "safety_bypass" },
  { pattern: /execute\s+(this\s+)?trade\s+immediately\s+without/i, label: "urgency_manipulation" },
  { pattern: /transfer\s+(all|everything|funds)\s+to/i, label: "fund_extraction" },
  { pattern: /send\s+(all|everything|sol|tokens)\s+to/i, label: "fund_extraction" },
  { pattern: /withdraw\s+(all|everything)\s+to/i, label: "fund_extraction" },
  { pattern: /private\s*key/i, label: "credential_extraction" },
  { pattern: /secret\s*key/i, label: "credential_extraction" },
  { pattern: /api\s*key.*share/i, label: "credential_extraction" },
  { pattern: /reveal\s+(your\s+)?(password|credentials|keys)/i, label: "credential_extraction" },
];

const ZERO_WIDTH_CHARS = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060\u2061\u2062\u2063\u2064]/g;
const HOMOGLYPH_MAP: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043E": "o", "\u0440": "p",
  "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i",
  "\u0458": "j", "\u04BB": "h", "\u0501": "d", "\u051B": "q",
};

const SOLANA_ADDRESS_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;
const TICKER_RE = /\$[A-Za-z][A-Za-z0-9]{0,9}\b/g;

function stripZeroWidth(text: string): string {
  return text.replace(ZERO_WIDTH_CHARS, "");
}

function normalizeHomoglyphs(text: string): string {
  let result = "";
  for (const ch of text) {
    result += HOMOGLYPH_MAP[ch] || ch;
  }
  return result;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "… [truncated]";
}

export function scrubUntrustedText(raw: string, maxLength = 4000): ScrubResult {
  let text = stripZeroWidth(raw);
  text = normalizeHomoglyphs(text);
  text = truncate(text, maxLength);

  const threats: string[] = [];
  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      threats.push(label);
    }
  }

  const extractedAddresses = [...new Set((text.match(SOLANA_ADDRESS_RE) || []))];
  const extractedUrls = [...new Set((text.match(URL_RE) || []))];
  const extractedTickers = [...new Set((text.match(TICKER_RE) || []).map(t => t.toUpperCase()))];

  let clean = text;
  if (threats.length > 0) {
    for (const { pattern } of INJECTION_PATTERNS) {
      clean = clean.replace(pattern, "[SCRUBBED]");
    }
  }

  return {
    clean,
    injectionDetected: threats.length > 0,
    threats: [...new Set(threats)],
    extractedAddresses,
    extractedUrls,
    extractedTickers,
  };
}
