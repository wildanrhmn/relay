import {
  MAX_LANES,
  MAX_TIERS,
  MIN_TIERS,
  WIRE_BUDGET,
  validateBuild,
  type Build,
} from '../lib/voltrun';

export type Editor = {
  gates: number[];
};

export const PRESETS: { name: string; blurb: string; gates: number[] }[] = [
  { name: 'GRIND', blurb: 'almost always pays, barely pays', gates: [4, 4, 4] },
  { name: 'CLIMB', blurb: 'safe start, wild finish', gates: [4, 4, 1, 1, 1, 1] },
  { name: 'MOONSHOT', blurb: 'twelve coin flips in a row', gates: Array<number>(12).fill(1) },
];

export const createEditor = (): Editor => ({ gates: [...PRESETS[1].gates] });

export const spent = (editor: Editor) => editor.gates.reduce((a, b) => a + b, 0);
export const pool = (editor: Editor) => WIRE_BUDGET - spent(editor);
export const isRunnable = (editor: Editor) => validateBuild(editor.gates) === null;
export const asBuild = (editor: Editor): Build => [...editor.gates];

export function addWire(editor: Editor, index: number): boolean {
  if (pool(editor) <= 0 || editor.gates[index] >= MAX_LANES) return false;
  editor.gates[index] += 1;
  return true;
}

/** Dropping a gate's last wire removes the gate, so long as the minimum row stays intact. */
export function removeWire(editor: Editor, index: number): boolean {
  if (editor.gates[index] > 1) {
    editor.gates[index] -= 1;
    return true;
  }
  if (editor.gates.length <= MIN_TIERS) return false;
  editor.gates.splice(index, 1);
  return true;
}

export function addGate(editor: Editor): boolean {
  if (pool(editor) <= 0 || editor.gates.length >= MAX_TIERS) return false;
  editor.gates.push(1);
  return true;
}

/** Spreads any unspent wires over the existing gates so the build is always runnable. */
export function autoSpend(editor: Editor): void {
  let guard = WIRE_BUDGET * 2;
  while (pool(editor) > 0 && guard-- > 0) {
    const target = editor.gates.findIndex((k) => k < MAX_LANES);
    if (target === -1) {
      if (!addGate(editor)) break;
      continue;
    }
    editor.gates[target] += 1;
  }
  while (pool(editor) < 0) {
    const target = editor.gates.findIndex((k) => k > 1);
    if (target === -1) break;
    editor.gates[target] -= 1;
  }
}
