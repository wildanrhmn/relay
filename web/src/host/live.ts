import { decodeAbiParameters, encodeAbiParameters } from 'viem';
import { computeMaxWager } from '../sdk/bet-limits';
import { connectGameToHost, observeGameContentSize } from '../sdk/guest';
import type { HostApiV1, HostSnapshotV1 } from '../sdk/types';
import { WAD, maxMultiplierWad, type Build } from '../lib/apparatus';
import type { GameHost, HostView, RoundView } from './types';

const BUILD_PARAMS = [{ type: 'uint8[]' }] as const;
const STATE_PARAMS = [{ type: 'uint8' }, { type: 'uint256' }] as const;

export const encodeBuild = (build: Build) => encodeAbiParameters(BUILD_PARAMS, [build as readonly number[]]);

function decodeBuild(gameData: string | undefined): Build | null {
  if (!gameData || gameData === '0x') return null;
  try {
    return [...(decodeAbiParameters(BUILD_PARAMS, gameData as `0x${string}`)[0] as readonly number[])];
  } catch {
    return null;
  }
}

function decodeState(gameState: string | undefined): { depth: number; payout: bigint } | null {
  if (!gameState || gameState === '0x') return null;
  try {
    const [depth, payout] = decodeAbiParameters(STATE_PARAMS, gameState as `0x${string}`);
    return { depth: Number(depth), payout };
  } catch {
    return null;
  }
}

const TERMINAL = new Set(['SETTLED', 'FORFEITED', 'CANCELLED']);

/**
 * Resolves to a live host, or null when no bridge answers within `timeoutMs` —
 * which is the normal case for the standalone URL.
 */
export async function connectLiveHost(timeoutMs = 1500): Promise<GameHost | null> {
  let snapshot: HostSnapshotV1 | null = null;
  const listeners = new Set<(view: HostView) => void>();
  const buildsByKey = new Map<string, Build>();
  const revealed = new Set<string>();

  const connection = connectGameToHost({
    async setState(next) {
      snapshot = next;
      emit();
    },
  });

  let hostApi: HostApiV1;
  try {
    hostApi = await Promise.race([
      connection.promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no host')), timeoutMs)),
    ]);
  } catch {
    connection.destroy();
    return null;
  }

  observeGameContentSize(hostApi);

  const rounds = (): RoundView[] => {
    const items = snapshot?.sessions.items ?? [];
    return items.flatMap((item) => {
      const build = decodeBuild(item.raw?.gameData) ?? buildsByKey.get(item.sessionKey);
      if (!build) return [];
      const state = decodeState(item.raw?.gameState);
      const settled = item.isSettled || TERMINAL.has(item.phaseName ?? '');
      return [
        {
          key: item.sessionKey,
          sessionId: item.sessionId,
          build,
          wager: BigInt(item.stake ?? item.wager ?? '0'),
          settled,
          depth: settled ? state?.depth : undefined,
          payout: settled ? (item.payout !== undefined ? BigInt(item.payout) : state?.payout) : undefined,
          randomness: item.raw?.randomness ? BigInt(item.raw.randomness) : undefined,
        },
      ];
    });
  };

  const view = (): HostView => ({
    ready: snapshot?.wallet.status === 'ready',
    resolved: snapshot !== null,
    demo: false,
    balance: BigInt(snapshot?.balances.smartVaultBalance ?? '0'),
    decimals: snapshot?.token.decimals ?? 18,
    symbol: snapshot?.token.symbol ?? 'chUSD',
    rounds: rounds(),
    maxWagerFor: (build) =>
      computeMaxWager(snapshot, { maxMultiplierX: Number(maxMultiplierWad(build)) / Number(WAD) }) ?? null,
  });

  function emit() {
    const current = view();
    for (const listener of listeners) listener(current);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      listener(view());
      return () => listeners.delete(listener);
    },
    view,
    async openRound(wager, build) {
      const { sessionKey } = await hostApi.openSession({
        wager: wager.toString(),
        gameData: encodeBuild(build),
      });
      buildsByKey.set(sessionKey, build);
      return sessionKey;
    },
    async reveal(key) {
      const round = rounds().find((item) => item.key === key);
      // The host hides winnings from its balance display until this fires, so it
      // must be called exactly once, after the reveal animation finishes.
      if (!round?.sessionId || revealed.has(key)) return;
      revealed.add(key);
      await hostApi.revealOutcome({ sessionId: round.sessionId });
    },
    destroy() {
      listeners.clear();
      connection.destroy();
    },
  };
}
