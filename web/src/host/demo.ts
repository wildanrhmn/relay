/**
 * Standalone demo host.
 *
 * The jam requires the hosted URL to be playable on its own, outside the
 * chain.wtf iframe — judges and the gallery open it directly. This stands in for
 * the real host with a local balance and browser randomness. It is only ever
 * used when no bridge answers; a live host always wins.
 */
import { WAD, maxMultiplierWad, multiplierWad, resolveDepth, type Build } from '../lib/voltrun';
import type { GameHost, HostView, RoundView } from './types';

const STARTING_BALANCE = 1_000n * WAD;
const SETTLE_DELAY_MS = 550;

function randomWord(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = 0n;
  for (const byte of bytes) out = (out << 8n) | BigInt(byte);
  return out;
}

/** Demo-only tuning switch: `?force=clear` makes every wire survive so the full-clear celebration can be seen on demand. */
export function createDemoHost(options: { forceClear?: boolean } = {}): GameHost {
  let balance = STARTING_BALANCE;
  let counter = 0;
  const rounds = new Map<string, RoundView>();
  const listeners = new Set<(view: HostView) => void>();

  const view = (): HostView => ({
    ready: true,
    resolved: true,
    demo: true,
    balance,
    decimals: 18,
    symbol: 'chUSD',
    rounds: [...rounds.values()],
    maxWagerFor: () => balance,
  });

  const emit = () => {
    const snapshot = view();
    for (const listener of listeners) listener(snapshot);
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(view());
      return () => listeners.delete(listener);
    },
    view,
    async openRound(wager, build: Build) {
      if (wager > balance) throw new Error('insufficient demo balance');
      const key = `demo:${++counter}`;
      balance -= wager;
      rounds.set(key, { key, sessionId: key, build, wager, settled: false });
      emit();

      setTimeout(() => {
        const round = rounds.get(key);
        if (!round) return;
        const randomness = options.forceClear ? (1n << 256n) - 1n : randomWord();
        const depth = resolveDepth(build, randomness);
        rounds.set(key, {
          ...round,
          settled: true,
          depth,
          randomness,
          payout: (wager * multiplierWad(build, depth)) / WAD,
        });
        emit();
      }, SETTLE_DELAY_MS);

      return key;
    },
    async reveal(key) {
      const round = rounds.get(key);
      if (!round?.settled || !round.payout) return;
      balance += round.payout;
      emit();
    },
    destroy() {
      listeners.clear();
    },
  };
}

/** Worst-case payout multiplier of a build, for wager clamping. */
export const maxMultiplierX = (build: Build): number => Number(maxMultiplierWad(build)) / Number(WAD);
