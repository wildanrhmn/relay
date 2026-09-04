export type StageEvent =
  | { type: 'charge' }
  | { type: 'lane'; live: boolean }
  | { type: 'gate'; index: number }
  | { type: 'failed'; index: number }
  | { type: 'won'; gates: number };

/** Implemented by both the WebGL corridor and the 2D fallback stage. */
export interface StageLike {
  setBuild(lanes: number[]): void;
  setHover(index: number): void;
  gateAt(x: number, y: number): number;
  play(trace: boolean[][]): Promise<void>;
  clearRound(): void;
  /** Multiplier chips drawn over each gate; the 2D fallback ignores them. */
  setLabels?(texts: string[]): void;
  destroy(): void;
}
