import type Database from "better-sqlite3";

export interface ProfileEntry {
  key: string;
  value: string;
  confidence: number;
  observedAt: number;
  lastReinforcedAt: number | null;
  evidenceCount: number;
  metadata: string | null;
  /** 当前真实 confidence(经过衰减) */
  effectiveConfidence: number;
}

const DECAY_RATE = 0.01; // per day
const MIN_CONFIDENCE = 0.1;

export function getProfile(db: Database.Database, key: string): ProfileEntry | null {
  const r = db.prepare(`SELECT * FROM user_profile WHERE key = ?`).get(key) as Record<string, unknown> | undefined;
  return r ? withEffective(rowToProfile(r)) : null;
}

export function listProfile(db: Database.Database): ProfileEntry[] {
  const rows = db.prepare(`SELECT * FROM user_profile ORDER BY confidence DESC, observed_at DESC`).all() as Array<
    Record<string, unknown>
  >;
  const now = Date.now();
  return rows
    .map(rowToProfile)
    .map((p) => withEffective(p, now))
    .filter((p) => p.effectiveConfidence >= MIN_CONFIDENCE);
}

export function upsertProfile(
  db: Database.Database,
  key: string,
  value: string,
  confidence: number = 0.7,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO user_profile (key, value, confidence, observed_at, last_reinforced_at, evidence_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       confidence = MAX(confidence, excluded.confidence),
       observed_at = excluded.observed_at,
       last_reinforced_at = excluded.observed_at,
       evidence_count = evidence_count + 1`,
  ).run(key, value, confidence, now, now);
}

export function reinforceProfile(db: Database.Database, key: string): void {
  db.prepare(
    `UPDATE user_profile SET confidence = MIN(1.0, confidence * 1.1), last_reinforced_at = ? WHERE key = ?`,
  ).run(Date.now(), key);
}

function rowToProfile(r: Record<string, unknown>): ProfileEntry {
  return {
    key: r.key as string,
    value: r.value as string,
    confidence: r.confidence as number,
    observedAt: r.observed_at as number,
    lastReinforcedAt: (r.last_reinforced_at as number | null) ?? null,
    evidenceCount: r.evidence_count as number,
    metadata: (r.metadata as string | null) ?? null,
    effectiveConfidence: r.confidence as number,
  };
}

function withEffective(p: ProfileEntry, now: number = Date.now()): ProfileEntry {
  const daysSince = (now - p.observedAt) / 86_400_000;
  p.effectiveConfidence = p.confidence * Math.exp(-DECAY_RATE * daysSince);
  return p;
}