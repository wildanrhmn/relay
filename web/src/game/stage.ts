import { MAX_LANES } from '../lib/apparatus';

export type StageEvent =
  | { type: 'charge' }
  | { type: 'lane'; live: boolean }
  | { type: 'gate'; index: number }
  | { type: 'failed'; index: number }
  | { type: 'won'; gates: number };

type GateAnim = {
  lanes: boolean[];
  /** 0 while the current is still upstream, 1 once this gate has fully resolved. */
  resolve: number;
  settled: boolean;
};

const COLORS = {
  bg: '#08090d',
  frame: '#1c2130',
  frameLive: '#2a5f57',
  wireIdle: '#2f3646',
  wireLive: '#6ef7cf',
  wireDead: '#4a2130',
  spine: '#161b26',
  current: '#a9fff2',
  fail: '#ff5c6e',
  gold: '#ffd166',
};

const GATE_MS = 165;
const LANE_MS = 55;
const END_MS = 520;

export class Stage {
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private width = 0;
  private height = 0;
  private dpr = 1;

  private gates: number[] = [];
  private hover = -1;

  private anim: {
    trace: boolean[][];
    depth: number;
    total: number;
    start: number;
    emitted: Set<string>;
    done: boolean;
  } | null = null;

  private emit: (event: StageEvent) => void;
  private reduceMotion = false;

  constructor(private canvas: HTMLCanvasElement, emit: (event: StageEvent) => void) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    this.ctx = ctx;
    this.emit = emit;
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loop();
  }

  setBuild(gates: number[]): void {
    this.gates = [...gates];
  }

  setHover(index: number): void {
    this.hover = index;
  }

  gateAt(x: number): number {
    const layout = this.layout();
    for (let i = 0; i < layout.length; i++) {
      if (x >= layout[i].x - layout[i].gap / 2 && x <= layout[i].x + layout[i].w + layout[i].gap / 2) return i;
    }
    return -1;
  }

  play(trace: boolean[][], depth: number, total: number): Promise<void> {
    this.anim = { trace, depth, total, start: performance.now(), emitted: new Set(), done: false };
    this.emit({ type: 'charge' });

    const laneCount = trace.reduce((acc, gate) => acc + gate.length, 0);
    const duration = this.reduceMotion ? 260 : trace.length * GATE_MS + laneCount * LANE_MS + END_MS;
    return new Promise((resolve) => setTimeout(() => {
      if (this.anim) this.anim.done = true;
      resolve();
    }, duration));
  }

  clearRound(): void {
    this.anim = null;
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.floor(rect.width * this.dpr);
    this.canvas.height = Math.floor(rect.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private layout() {
    const count = Math.max(this.gates.length, 1);
    const padX = 46;
    const usable = this.width - padX * 2;
    const gap = Math.min(16, usable / (count * 5));
    const w = (usable - gap * (count - 1)) / count;
    return this.gates.map((lanes, i) => ({ x: padX + i * (w + gap), w, gap, lanes }));
  }

  /** Milliseconds into the run at which gate `index` begins resolving. */
  private gateStart(index: number): number {
    if (!this.anim) return 0;
    let t = 0;
    for (let i = 0; i < index; i++) {
      t += GATE_MS + (this.anim.trace[i]?.length ?? 0) * LANE_MS;
    }
    return t;
  }

  private animState(): GateAnim[] | null {
    if (!this.anim) return null;
    const elapsed = this.reduceMotion ? Number.MAX_SAFE_INTEGER : performance.now() - this.anim.start;

    return this.gates.map((lanes, i) => {
      const traced = this.anim!.trace[i];
      if (!traced) return { lanes: Array<boolean>(lanes).fill(false), resolve: 0, settled: false };

      const start = this.gateStart(i);
      const span = GATE_MS + traced.length * LANE_MS;
      const resolve = Math.max(0, Math.min(1, (elapsed - start) / span));

      if (resolve > 0 && !this.anim!.emitted.has(`g${i}`)) {
        this.anim!.emitted.add(`g${i}`);
        traced.forEach((live, laneIndex) => {
          setTimeout(() => this.emit({ type: 'lane', live }), laneIndex * LANE_MS);
        });
      }
      if (resolve >= 1 && !this.anim!.emitted.has(`r${i}`)) {
        this.anim!.emitted.add(`r${i}`);
        const passed = traced.some(Boolean);
        if (passed) this.emit({ type: 'gate', index: i });
        else this.emit({ type: 'failed', index: i });
        if (passed && i === this.anim!.total - 1) this.emit({ type: 'won', gates: this.anim!.total });
      }

      return { lanes: traced, resolve, settled: resolve >= 1 };
    });
  }

  private loop = (): void => {
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  private draw(): void {
    const { ctx } = this;
    const state = this.animState();
    const midY = this.height / 2;

    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.width, this.height);

    const layout = this.layout();
    const laneH = Math.min(15, (this.height - 96) / MAX_LANES);
    const laneGap = 6;

    ctx.strokeStyle = COLORS.spine;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(16, midY);
    ctx.lineTo(this.width - 16, midY);
    ctx.stroke();

    const reachedGate = state ? state.findIndex((g) => g.settled && !g.lanes.some(Boolean)) : -1;
    const clearedCount = state ? state.filter((g) => g.settled && g.lanes.some(Boolean)).length : 0;

    this.drawTerminal(16, midY, clearedCount > 0, false);

    layout.forEach((gate, i) => {
      const anim = state?.[i];
      const stack = gate.lanes;
      const totalH = stack * laneH + (stack - 1) * laneGap;
      const top = midY - totalH / 2;
      const failedHere = reachedGate === i;
      const dimmed = reachedGate !== -1 && i > reachedGate;

      ctx.globalAlpha = dimmed ? 0.25 : 1;

      ctx.strokeStyle = anim?.settled && anim.lanes.some(Boolean) ? COLORS.frameLive : COLORS.frame;
      ctx.lineWidth = this.hover === i && !state ? 2 : 1;
      this.roundRect(gate.x - 6, top - 12, gate.w + 12, totalH + 24, 8);
      ctx.stroke();

      for (let lane = 0; lane < stack; lane++) {
        const y = top + lane * (laneH + laneGap);
        const revealed = anim ? anim.resolve * stack > lane : false;
        const live = anim?.lanes[lane] ?? false;

        let fill = COLORS.wireIdle;
        if (anim && revealed) fill = live ? COLORS.wireLive : COLORS.wireDead;

        if (anim && revealed && live) {
          ctx.shadowColor = COLORS.wireLive;
          ctx.shadowBlur = 14;
        }
        ctx.fillStyle = fill;
        this.roundRect(gate.x, y, gate.w, laneH, laneH / 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      if (failedHere) {
        ctx.strokeStyle = COLORS.fail;
        ctx.lineWidth = 2;
        this.roundRect(gate.x - 6, top - 12, gate.w + 12, totalH + 24, 8);
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
      ctx.fillStyle = anim?.settled && anim.lanes.some(Boolean) ? COLORS.wireLive : '#414a5e';
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), gate.x + gate.w / 2, top + totalH + 26);
    });

    const won = state !== null && clearedCount === this.gates.length && this.gates.length > 0;
    this.drawTerminal(this.width - 16, midY, won, won);
  }

  private drawTerminal(x: number, y: number, live: boolean, gold: boolean): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    if (live) {
      ctx.shadowColor = gold ? COLORS.gold : COLORS.current;
      ctx.shadowBlur = 20;
    }
    ctx.fillStyle = live ? (gold ? COLORS.gold : COLORS.current) : COLORS.frame;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const { ctx } = this;
    const radius = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
}
