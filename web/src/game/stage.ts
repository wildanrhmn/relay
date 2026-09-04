export type StageEvent =
  | { type: 'charge' }
  | { type: 'lane'; live: boolean }
  | { type: 'gate'; index: number }
  | { type: 'failed'; index: number }
  | { type: 'won'; gates: number };

const COLORS = {
  bg: '#08090d',
  frame: '#1c2130',
  frameLive: '#2f6f63',
  wireIdle: '#2b3242',
  wireLive: '#6ef7cf',
  wireDead: '#5a2233',
  spine: '#161b26',
  current: '#c4fff5',
  fail: '#ff5c6e',
  gold: '#ffd166',
  label: '#4a5468',
};

const GATE_MS = 150;
const LANE_MS = 52;
const END_MS = 560;

type Spark = { x: number; y: number; vx: number; vy: number; life: number; hue: 'dead' | 'live' };

export class Stage {
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private width = 0;
  private height = 0;

  private gates: number[] = [];
  private hover = -1;
  private sparks: Spark[] = [];
  private flash = 0;
  private lastFrame = 0;

  private anim: { trace: boolean[][]; emitted: Set<string>; start: number } | null = null;
  private emit: (event: StageEvent) => void;
  private reduceMotion: boolean;

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
      if (x >= layout[i].x - 8 && x <= layout[i].x + layout[i].w + 8) return i;
    }
    return -1;
  }

  play(trace: boolean[][]): Promise<void> {
    this.sparks = [];
    this.anim = { trace, emitted: new Set(), start: performance.now() };
    this.emit({ type: 'charge' });

    const lanes = trace.reduce((acc, gate) => acc + gate.length, 0);
    const duration = this.reduceMotion ? 240 : trace.length * GATE_MS + lanes * LANE_MS + END_MS;
    return new Promise((resolve) => setTimeout(resolve, duration));
  }

  clearRound(): void {
    this.anim = null;
    this.sparks = [];
    this.flash = 0;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private layout() {
    const count = Math.max(this.gates.length, 1);
    const padX = 44;
    const usable = this.width - padX * 2;
    const gap = Math.max(7, Math.min(18, usable / (count * 4.5)));
    const w = (usable - gap * (count - 1)) / count;
    return this.gates.map((lanes, i) => ({ x: padX + i * (w + gap), w, lanes }));
  }

  private gateStart(index: number): number {
    if (!this.anim) return 0;
    let t = 0;
    for (let i = 0; i < index; i++) t += GATE_MS + (this.anim.trace[i]?.length ?? 0) * LANE_MS;
    return t;
  }

  /** Per-gate reveal progress in [0,1], plus event dispatch as each gate lands. */
  private progress(): number[] | null {
    if (!this.anim) return null;
    const elapsed = this.reduceMotion ? Number.MAX_SAFE_INTEGER : performance.now() - this.anim.start;

    return this.gates.map((_, i) => {
      const traced = this.anim!.trace[i];
      if (!traced) return 0;

      const span = GATE_MS + traced.length * LANE_MS;
      const value = Math.max(0, Math.min(1, (elapsed - this.gateStart(i)) / span));

      if (value > 0 && !this.anim!.emitted.has(`g${i}`)) {
        this.anim!.emitted.add(`g${i}`);
        traced.forEach((live, lane) => setTimeout(() => this.emit({ type: 'lane', live }), lane * LANE_MS));
      }
      if (value >= 1 && !this.anim!.emitted.has(`r${i}`)) {
        this.anim!.emitted.add(`r${i}`);
        const passed = traced.some(Boolean);
        if (passed) {
          this.emit({ type: 'gate', index: i });
          if (i === this.gates.length - 1) {
            this.emit({ type: 'won', gates: this.gates.length });
            this.flash = 1;
          }
        } else {
          this.emit({ type: 'failed', index: i });
          this.flash = 0.55;
        }
      }
      return value;
    });
  }

  private loop = (): void => {
    const now = performance.now();
    const dt = Math.min(48, now - (this.lastFrame || now));
    this.lastFrame = now;
    this.step(dt);
    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };

  private step(dt: number): void {
    this.flash = Math.max(0, this.flash - dt / 520);
    this.sparks = this.sparks.filter((s) => {
      s.x += s.vx * (dt / 16);
      s.y += s.vy * (dt / 16);
      s.vy += dt / 260;
      s.life -= dt / 460;
      return s.life > 0;
    });
  }

  private spawnSparks(x: number, y: number, hue: 'dead' | 'live'): void {
    if (this.reduceMotion) return;
    const count = hue === 'dead' ? 7 : 4;
    for (let i = 0; i < count; i++) {
      this.sparks.push({
        x,
        y,
        vx: (Math.random() - 0.4) * 2.4,
        vy: (Math.random() - 0.5) * 2.2,
        life: 0.6 + Math.random() * 0.4,
        hue,
      });
    }
  }

  private draw(): void {
    const { ctx } = this;
    const progress = this.progress();
    const midY = this.height / 2;
    const layout = this.layout();

    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.width, this.height);

    // Scale to the tallest gate in *this* build so a row of single wires reads as
    // substantial rather than as a thin line floating in an empty frame.
    const tallest = Math.max(1, ...this.gates);
    const laneGap = 7;
    const laneH = Math.max(10, Math.min(30, (this.height - 96 - (tallest - 1) * laneGap) / tallest));

    const failedAt = progress
      ? progress.findIndex((p, i) => p >= 1 && this.anim?.trace[i] && !this.anim.trace[i].some(Boolean))
      : -1;
    const cleared = progress
      ? progress.filter((p, i) => p >= 1 && this.anim?.trace[i]?.some(Boolean)).length
      : 0;

    ctx.strokeStyle = COLORS.spine;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(14, midY);
    ctx.lineTo(this.width - 14, midY);
    ctx.stroke();

    this.drawCurrent(progress, layout, midY, failedAt);

    layout.forEach((gate, i) => {
      const value = progress?.[i] ?? 0;
      const traced = this.anim?.trace[i];
      const stack = gate.lanes;
      const totalH = stack * laneH + (stack - 1) * laneGap;
      const top = midY - totalH / 2;
      const passed = value >= 1 && traced?.some(Boolean);
      const failedHere = failedAt === i;
      const dimmed = failedAt !== -1 && i > failedAt;

      ctx.globalAlpha = dimmed ? 0.18 : 1;

      ctx.strokeStyle = failedHere ? COLORS.fail : passed ? COLORS.frameLive : COLORS.frame;
      ctx.lineWidth = failedHere ? 2 : this.hover === i && !progress ? 1.6 : 1;
      this.roundRect(gate.x - 5, top - 11, gate.w + 10, totalH + 22, 9);
      ctx.stroke();

      for (let lane = 0; lane < stack; lane++) {
        const y = top + lane * (laneH + laneGap);
        const revealed = traced ? value * stack > lane : false;
        const live = traced?.[lane] ?? false;

        if (revealed && !this.anim?.emitted.has(`s${i}-${lane}`)) {
          this.anim?.emitted.add(`s${i}-${lane}`);
          this.spawnSparks(gate.x + gate.w / 2, y + laneH / 2, live ? 'live' : 'dead');
        }

        if (revealed && live) {
          ctx.shadowColor = COLORS.wireLive;
          ctx.shadowBlur = 16;
        }
        ctx.fillStyle = revealed ? (live ? COLORS.wireLive : COLORS.wireDead) : COLORS.wireIdle;
        this.roundRect(gate.x, y, gate.w, laneH, laneH / 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      ctx.globalAlpha = dimmed ? 0.3 : 1;
      ctx.fillStyle = passed ? COLORS.wireLive : failedHere ? COLORS.fail : COLORS.label;
      ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), gate.x + gate.w / 2, top + totalH + 25);
      ctx.globalAlpha = 1;
    });

    this.drawSparks();

    const won = progress !== null && cleared === this.gates.length && this.gates.length > 0;
    this.drawTerminal(14, midY, progress !== null, false);
    this.drawTerminal(this.width - 14, midY, won, won);

    if (this.flash > 0) {
      ctx.fillStyle = won ? `rgba(255,209,102,${this.flash * 0.1})` : `rgba(255,92,110,${this.flash * 0.07})`;
      ctx.fillRect(0, 0, this.width, this.height);
    }
  }

  /** The live beam, running from the source to wherever the current has reached. */
  private drawCurrent(
    progress: number[] | null,
    layout: { x: number; w: number }[],
    midY: number,
    failedAt: number,
  ): void {
    if (!progress || layout.length === 0) return;
    const { ctx } = this;

    let frontier = 14;
    for (let i = 0; i < layout.length; i++) {
      const value = progress[i];
      if (value <= 0) break;
      const gate = layout[i];
      frontier = gate.x + gate.w * Math.min(1, value);
      if (value >= 1 && failedAt === i) break;
      if (value >= 1 && i === layout.length - 1) frontier = this.width - 14;
    }

    const grad = ctx.createLinearGradient(14, 0, frontier, 0);
    grad.addColorStop(0, 'rgba(110,247,207,0.25)');
    grad.addColorStop(1, COLORS.current);

    ctx.strokeStyle = grad;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = COLORS.current;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(14, midY);
    ctx.lineTo(frontier, midY);
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (failedAt === -1) {
      ctx.beginPath();
      ctx.arc(frontier, midY, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.current;
      ctx.shadowColor = COLORS.current;
      ctx.shadowBlur = 16;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  private drawSparks(): void {
    const { ctx } = this;
    for (const spark of this.sparks) {
      ctx.globalAlpha = Math.max(0, spark.life);
      ctx.fillStyle = spark.hue === 'live' ? COLORS.wireLive : COLORS.fail;
      ctx.fillRect(spark.x, spark.y, 1.8, 1.8);
    }
    ctx.globalAlpha = 1;
  }

  private drawTerminal(x: number, y: number, live: boolean, gold: boolean): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, 6.5, 0, Math.PI * 2);
    if (live) {
      ctx.shadowColor = gold ? COLORS.gold : COLORS.current;
      ctx.shadowBlur = gold ? 26 : 16;
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
