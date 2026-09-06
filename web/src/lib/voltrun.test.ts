import { describe, expect, it } from 'vitest';
import {
  MAX_LANES,
  MAX_TIERS,
  MIN_TIERS,
  RTP_WAD,
  WAD,
  WIRE_BUDGET,
  enumerateBuilds,
  maxMultiplierWad,
  multiplierWad,
  paytable,
  payoutWad,
  realisedRtpWad,
  resolveDepth,
  resolveTrace,
  topProbabilityWad,
  validateBuild,
} from './voltrun';

const BALANCED = [3, 2, 2, 2, 1, 1, 1];
const GRIND = [4, 4, 4];
const MOONSHOT = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

describe('validateBuild', () => {
  it('accepts builds that spend the whole budget', () => {
    expect(validateBuild(GRIND)).toBeNull();
    expect(validateBuild(BALANCED)).toBeNull();
    expect(validateBuild(MOONSHOT)).toBeNull();
  });

  it('rejects an over- or under-spent budget', () => {
    expect(validateBuild([4, 4, 3])).toMatch(/exactly/);
    expect(validateBuild([4, 4, 4, 1])).toMatch(/exactly/);
  });

  it('rejects illegal gate sizes and gate counts', () => {
    expect(validateBuild([8, 2, 2])).toMatch(/1-4/);
    expect(validateBuild([0, 4, 4, 4])).toMatch(/1-4/);
    expect(validateBuild([4, 3, 2, 1, 1, 1])).toBeNull();
    expect(validateBuild(Array(13).fill(1) as number[])).toMatch(/at most/);
  });
});

describe('paytable', () => {
  it('covers the whole outcome space', () => {
    for (const build of [GRIND, BALANCED, MOONSHOT]) {
      const rows = paytable(build);
      const lost = (1n << BigInt(WIRE_BUDGET)) - rows[0].reachNum;
      const total = rows.reduce((acc, row) => acc + row.exactNum, lost);
      expect(total).toBe(1n << BigInt(WIRE_BUDGET));
    }
  });

  it('pays strictly more the deeper the current gets', () => {
    for (const build of [GRIND, BALANCED, MOONSHOT]) {
      const rows = paytable(build);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].multWad).toBeGreaterThan(rows[i - 1].multWad);
      }
    }
  });

  it('spans a wide multiplier range across the build space', () => {
    expect(Number(maxMultiplierWad(GRIND)) / Number(WAD)).toBeLessThan(2);
    expect(Number(maxMultiplierWad(MOONSHOT)) / Number(WAD)).toBeGreaterThan(500);
  });
});

describe('RTP invariant', () => {
  // The whole design rests on this: every legal build must return the same RTP,
  // so no configuration is better or worse than any other and the declared
  // number on the submission form is true for all of them.
  it('holds for every legal build', () => {
    const builds = enumerateBuilds();
    expect(builds.length).toBeGreaterThan(100);

    const tolerance = WAD / 100_000n;
    for (const build of builds) {
      const rtp = realisedRtpWad(build);
      expect(rtp).toBeLessThanOrEqual(RTP_WAD);
      expect(RTP_WAD - rtp).toBeLessThan(tolerance);
    }
  });

  it('never rounds in the player-favouring direction', () => {
    for (const build of enumerateBuilds()) {
      expect(realisedRtpWad(build)).toBeLessThanOrEqual(RTP_WAD);
    }
  });
});

describe('resolveDepth', () => {
  it('stops at the first gate where every lane dies', () => {
    // GRIND is [4,4,4]; bits are read MSB-first, one per lane.
    const allLive = (1n << 256n) - 1n;
    expect(resolveDepth(GRIND, allLive)).toBe(3);

    const firstGateDead = ((1n << 252n) - 1n) << 0n;
    expect(resolveDepth(GRIND, firstGateDead)).toBe(0);
  });

  it('passes a gate when any single lane survives', () => {
    const oneLaneInFirstGate = 1n << 252n;
    expect(resolveDepth(GRIND, oneLaneInFirstGate)).toBe(1);
  });

  it('produces a trace consistent with the resolved depth', () => {
    for (let seed = 0; seed < 200; seed++) {
      const randomness = BigInt(`0x${seed.toString(16).padStart(2, '0')}`.padEnd(66, 'a'));
      const depth = resolveDepth(BALANCED, randomness);
      const trace = resolveTrace(BALANCED, randomness);
      const cleared = trace.filter((gate) => gate.some(Boolean)).length;
      expect(cleared).toBe(depth);
    }
  });

  it('pays zero when the first gate fails', () => {
    expect(payoutWad(GRIND, 0n)).toBe(0n);
    expect(multiplierWad(GRIND, 0)).toBe(0n);
  });
});

describe('risk quoting', () => {
  it('reports the top-prize probability the house reserves against', () => {
    const p = topProbabilityWad(MOONSHOT);
    expect(p).toBeGreaterThan(0n);
    expect(p).toBeLessThan(WAD);

    const rows = paytable(MOONSHOT);
    const expected = (rows[rows.length - 1].reachNum * WAD) >> BigInt(WIRE_BUDGET);
    expect(p).toBe(expected);
  });

  it('keeps max payout consistent with the paytable', () => {
    for (const build of [GRIND, BALANCED, MOONSHOT]) {
      const rows = paytable(build);
      expect(maxMultiplierWad(build)).toBe(rows[rows.length - 1].multWad);
    }
  });
});

describe('empirical convergence', () => {
  // Guards against a paytable that is exactly right on paper but wired to a
  // resolver that reads bits differently.
  const lcg = (seed: bigint) => {
    let state = seed;
    return () => {
      state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      let out = 0n;
      for (let i = 0; i < 4; i++) {
        state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
        out = (out << 64n) | state;
      }
      return out;
    };
  };

  for (const [name, build] of [
    ['GRIND', GRIND],
    ['BALANCED', BALANCED],
    ['MOONSHOT', MOONSHOT],
  ] as const) {
    it(`converges toward the declared RTP for ${name}`, () => {
      const next = lcg(0xc0ffeen);
      const rounds = 200_000;
      let total = 0n;
      for (let i = 0; i < rounds; i++) total += payoutWad(build, next());

      const empirical = Number(total / BigInt(rounds)) / Number(WAD);
      const declared = Number(RTP_WAD) / Number(WAD);
      expect(Math.abs(empirical - declared)).toBeLessThan(0.15);
    });
  }
});

describe('constants', () => {
  it('keeps the budget spendable across the allowed gate counts', () => {
    expect(MIN_TIERS * MAX_LANES).toBeGreaterThanOrEqual(WIRE_BUDGET);
    expect(MAX_TIERS).toBeLessThanOrEqual(WIRE_BUDGET);
  });
});
