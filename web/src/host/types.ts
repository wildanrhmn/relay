import type { Build } from '../lib/apparatus';

export type RoundView = {
  key: string;
  sessionId?: string;
  build: Build;
  wager: bigint;
  settled: boolean;
  depth?: number;
  payout?: bigint;
  randomness?: bigint;
};

export type HostView = {
  ready: boolean;
  /** False until we know whether a real host is there, so the UI can hold still. */
  resolved: boolean;
  demo: boolean;
  balance: bigint;
  decimals: number;
  symbol: string;
  rounds: RoundView[];
  /** Visible height inside the host iframe, when the host reports one. */
  availableHeight?: number;
  /** Null when the host publishes no limit; the caller falls back to its own cap. */
  maxWagerFor(build: Build): bigint | null;
};

export interface GameHost {
  subscribe(listener: (view: HostView) => void): () => void;
  view(): HostView;
  openRound(wager: bigint, build: Build): Promise<string>;
  /** Called once the win presentation finishes so the host un-clamps its balance display. */
  reveal(key: string): Promise<void>;
  destroy(): void;
}
