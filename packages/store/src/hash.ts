import { createHash } from "node:crypto";
import type { Card } from "./types.ts";

/** JSON with object keys sorted at every level, so equal content serializes identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// @spec ART-LEAN-002
export function cardHash(card: Card): string {
  return sha256(canonicalJson(card));
}

export interface CacheKeyParts {
  inputs: unknown;
  upstream: Record<string, string>;
  files: Record<string, string>;
  config: unknown;
  schemaVersion: string;
}

// @spec ART-STAGE-005
export function computeCacheKey(parts: CacheKeyParts): string {
  return sha256(canonicalJson(parts));
}

// @spec ART-RUN-002
export function deriveRunId(base: string, head: string): string {
  return sha256(`${base}:${head}`).slice(0, 16);
}

/** Collapses all whitespace so formatting changes do not alter a fingerprint. */
export function normalizeCode(code: string): string {
  return code.replace(/\s+/g, "");
}

// @spec ART-FIND-006
export function findingFingerprint(f: { file: string; pattern?: string; code?: string; category: string }): string {
  const locator = f.pattern ?? normalizeCode(f.code ?? "");
  return sha256([f.file, locator, f.category].join("\0")).slice(0, 16);
}

export function countWords(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}
