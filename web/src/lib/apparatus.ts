/**
 * Apparatus — exact game math.
 *
 * This module is the single source of truth for the paytable and is mirrored
 * line-for-line by contracts/Apparatus.sol. Every quantity is an exact integer:
 * a gate with k lanes passes with probability (2^k - 1) / 2^k, so the whole
 * probability space is rational with denominator 2^WIRE_BUDGET and never needs
 * floating point. TS and Solidity therefore agree bit-for-bit.
 */

export const WAD = 10n ** 18n;

export const RTP_WAD = 960_000_000_000_000_000n;

export const WIRE_BUDGET = 12;
export const MAX_LANES = 4;
export const MIN_TIERS = 3;
export const MAX_TIERS = 12;

const LANE_SCALE = 1 << MAX_LANES;

export type Build = readonly number[];

export type PaytableRow = {
  depth: number;
  /** Probability of stopping at exactly this depth, as a fraction of 2^WIRE_BUDGET. */
  exactNum: bigint;
  /** Probability of reaching at least this depth, as a fraction of 2^WIRE_BUDGET. */
  reachNum: bigint;
  multWad: bigint;
};

export function validateBuild(lanes: Build): string | null {
  if (lanes.length < MIN_TIERS) return `need at least ${MIN_TIERS} gates`;
  if (lanes.length > MAX_TIERS) return `at most ${MAX_TIERS} gates`;
  let sum = 0;
  for (const k of lanes) {
    if (!Number.isInteger(k) || k < 1 || k > MAX_LANES) return `each gate needs 1-${MAX_LANES} wires`;
    sum += k;
  }
  if (sum !== WIRE_BUDGET) return `must spend exactly ${WIRE_BUDGET} wires (spent ${sum})`;
  return null;
}

export function assertValidBuild(lanes: Build): void {
  const err = validateBuild(lanes);
  if (err) throw new Error(`invalid build: ${err}`);
}

/**
 * Cumulative products A_d = prod(2^k_i - 1) and shifts S_d = sum(k_i), so that
 * the chance of clearing the first d gates is exactly A_d / 2^(S_d).
 */
function cumulative(lanes: Build): { a: bigint[]; s: number[] } {
  const a: bigint[] = [1n];
  const s: number[] = [0];
  for (let i = 0; i < lanes.length; i++) {
    a.push(a[i] * BigInt((1 << lanes[i]) - 1));
    s.push(s[i] + lanes[i]);
  }
  return { a, s };
}

/** Denominator of the normalising constant C = RTP * LANE_SCALE / laneScaleSum(lanes). */
function laneScaleSum(lanes: Build): bigint {
  let e = 0;
  for (let i = 1; i < lanes.length; i++) e += 1 << (MAX_LANES - lanes[i]);
  return BigInt(LANE_SCALE + e);
}

/**
 * Payout multiplier for stopping at depth d, in WAD.
 *
 * mult(d) = C / R_d with C chosen so the expectation over every depth is exactly
 * RTP. Division floors, so realised RTP is at most the declared RTP — never above,
 * which would under-reserve the house.
 */
export function multiplierWad(lanes: Build, depth: number): bigint {
  assertValidBuild(lanes);
  if (depth <= 0) return 0n;
  if (depth > lanes.length) throw new Error('depth exceeds gate count');
  const { a, s } = cumulative(lanes);
  return (RTP_WAD * BigInt(LANE_SCALE) * (1n << BigInt(s[depth]))) / (laneScaleSum(lanes) * a[depth]);
}

export function paytable(lanes: Build): PaytableRow[] {
  assertValidBuild(lanes);
  const { a, s } = cumulative(lanes);
  const total = s[lanes.length];
  const reach = (d: number) => a[d] << BigInt(total - s[d]);

  const rows: PaytableRow[] = [];
  for (let d = 1; d <= lanes.length; d++) {
    const exactNum = d === lanes.length ? reach(d) : reach(d) - reach(d + 1);
    rows.push({ depth: d, exactNum, reachNum: reach(d), multWad: multiplierWad(lanes, d) });
  }
  return rows;
}

/** Exact realised RTP in WAD, summed over the full outcome space. */
export function realisedRtpWad(lanes: Build): bigint {
  const rows = paytable(lanes);
  const denom = 1n << BigInt(WIRE_BUDGET);
  let acc = 0n;
  for (const row of rows) acc += row.exactNum * row.multWad;
  return acc / denom;
}

export function maxMultiplierWad(lanes: Build): bigint {
  return multiplierWad(lanes, lanes.length);
}

/** Probability of clearing every gate, in WAD — the tail term the house reserves against. */
export function topProbabilityWad(lanes: Build): bigint {
  assertValidBuild(lanes);
  const { a, s } = cumulative(lanes);
  return (a[lanes.length] * WAD) >> BigInt(s[lanes.length]);
}

/**
 * Resolve a round. Each lane consumes one bit of VRF randomness and survives on a
 * 1; a gate passes if any of its lanes survive. Single bits are exactly uniform,
 * so no rejection sampling is needed here (unlike mapping bytes onto d6 faces).
 */
export function resolveDepth(lanes: Build, randomness: bigint): number {
  assertValidBuild(lanes);
  let cursor = 0;
  for (let i = 0; i < lanes.length; i++) {
    let passed = false;
    for (let lane = 0; lane < lanes[i]; lane++) {
      if ((randomness >> BigInt(255 - cursor)) & 1n) passed = true;
      cursor++;
    }
    if (!passed) return i;
  }
  return lanes.length;
}

/** Per-gate survival flags, for driving the reveal animation. */
export function resolveTrace(lanes: Build, randomness: bigint): boolean[][] {
  assertValidBuild(lanes);
  const trace: boolean[][] = [];
  let cursor = 0;
  for (let i = 0; i < lanes.length; i++) {
    const gate: boolean[] = [];
    for (let lane = 0; lane < lanes[i]; lane++) {
      gate.push(((randomness >> BigInt(255 - cursor)) & 1n) === 1n);
      cursor++;
    }
    trace.push(gate);
    if (!gate.some(Boolean)) break;
  }
  return trace;
}

export function payoutWad(lanes: Build, randomness: bigint): bigint {
  return multiplierWad(lanes, resolveDepth(lanes, randomness));
}

export function formatMultiplier(multWad: bigint): string {
  const hundredths = (multWad * 100n) / WAD;
  return `${(Number(hundredths) / 100).toFixed(2)}x`;
}

/** Every legal build, in canonical order — used by tests and by the preset search. */
export function enumerateBuilds(): Build[] {
  const out: Build[] = [];
  const walk = (prefix: number[], remaining: number) => {
    const tiers = prefix.length;
    if (remaining === 0) {
      if (tiers >= MIN_TIERS && tiers <= MAX_TIERS) out.push([...prefix]);
      return;
    }
    if (tiers >= MAX_TIERS) return;
    if (remaining < MAX_TIERS - tiers) {
      // fewer wires left than gates still needed at 1 wire each
      if (remaining < 1) return;
    }
    for (let k = 1; k <= Math.min(MAX_LANES, remaining); k++) {
      prefix.push(k);
      walk(prefix, remaining - k);
      prefix.pop();
    }
  };
  walk([], WIRE_BUDGET);
  return out;
}
