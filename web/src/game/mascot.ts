/**
 * Volt — the current, as a character.
 *
 * Each gate is a doorway with its wires as fuses on the lintel. Volt runs up,
 * the fuses test one by one, any live fuse slides the door open and Volt dashes
 * through; a door whose fuses all blow stays shut and Volt runs into it. How
 * far Volt gets is what the round pays on, so the punchline and the payout are
 * the same moment.
 *
 * Everything is drawn in code so nothing is blocked on an asset; the state
 * machine here is what a Rive or sprite version would plug into later.
 */
import type { StageEvent, StageLike } from './stage-api';

const DESIGN_H = 560;
const GROUND_Y = 468;
const SOURCE_X = 96;
const FIRST_DOOR_X = 330;
const DOOR_GAP = 236;
const DOOR_W = 108;
const DOOR_H = 206;
const VOLT_R = 30;

const COOL_AT = 7;

const C = {
  bg: '#0b0b0e',
  floor: '#101014',
  floorEdge: '#c9a24f',
  frame: '#1b1c22',
  frameEdge: '#2b2d36',
  brass: '#d9b45a',
  brassBright: '#ffe068',
  ink: '#1a1408',
  fuseIdle: '#3a3320',
  fuseLive: '#ffe068',
  fuseDead: '#221010',
  shutter: '#15161b',
  shutterLine: '#23252d',
  loss: '#ff3838',
  win: '#08d42f',
  cta: '#cf68ff',
  text: '#ffffff',
  textDim: 'rgba(255,255,255,0.42)',
};

type Mood = 'idle' | 'charge' | 'run' | 'brace' | 'happy' | 'dazed' | 'bow';

type Segment = {
  kind: 'charge' | 'run' | 'fuse' | 'open' | 'dash' | 'slam' | 'dazed' | 'win';
  t0: number;
  t1: number;
  gate: number;
  lane?: number;
  live?: boolean;
  fromX?: number;
  toX?: number;
};

type Particle = { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; color: string; kind: 'spark' | 'smoke' | 'star' | 'firework' };

const ease = {
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inCubic: (t: number) => t * t * t,
  outBack: (t: number) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2),
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class MascotStage implements StageLike {
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private width = 0;
  private height = 0;
  private scale = 1;

  private lanes: number[] = [];
  private labels: string[] = [];
  private hover = -1;

  private camX = 0;
  private particles: Particle[] = [];
  private lastFrame = 0;
  private blinkAt = 0;
  private flash = 0;
  private flashColor = C.loss;
  private shakeGate = -1;
  private shakeUntil = 0;

  private anim: { trace: boolean[][]; segments: Segment[]; start: number; emitted: Set<string>; total: number } | null = null;
  private emit: (event: StageEvent) => void;
  private reduceMotion: boolean;

  constructor(private canvas: HTMLCanvasElement, emit: (event: StageEvent) => void) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    this.ctx = ctx;
    this.emit = emit;
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.resize();
    window.addEventListener('resize', this.resize);
    this.loop();
  }

  // ---------- geometry ----------

  private doorX = (i: number) => FIRST_DOOR_X + i * DOOR_GAP;
  private approachX = (i: number) => this.doorX(i) - 74;
  private throughX = (i: number) => this.doorX(i) + 82;

  private viewW(): number {
    return this.width / this.scale;
  }

  // ---------- StageLike ----------

  setBuild(lanes: number[]): void {
    if (lanes.length === this.lanes.length && lanes.every((k, i) => k === this.lanes[i])) return;
    this.lanes = [...lanes];
    this.labels = this.labels.slice(0, lanes.length);
  }

  setLabels(texts: string[]): void {
    this.labels = [...texts];
  }

  setHover(index: number): void {
    this.hover = index;
  }

  gateAt(x: number, y: number): number {
    const wx = x / this.scale + this.camX;
    const wy = y / this.scale;
    for (let i = 0; i < this.lanes.length; i++) {
      const dx = this.doorX(i);
      if (wx >= dx - DOOR_W / 2 - 14 && wx <= dx + DOOR_W / 2 + 14 && wy >= GROUND_Y - DOOR_H - 40 && wy <= GROUND_Y) return i;
    }
    return -1;
  }

  play(trace: boolean[][]): Promise<void> {
    const segments = this.buildTimeline(trace);
    const total = segments.length ? segments[segments.length - 1].t1 : 0;
    this.particles = [];
    this.anim = { trace, segments, start: performance.now(), emitted: new Set(), total };
    return new Promise((resolve) => setTimeout(resolve, this.reduceMotion ? 300 : total + 120));
  }

  clearRound(): void {
    this.anim = null;
    this.particles = [];
    this.flash = 0;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
  }

  // ---------- timeline ----------

  /** Volt gets quicker and cockier the deeper the run goes. */
  private speedAfter(cleared: number): number {
    return Math.max(0.55, Math.pow(0.9, cleared));
  }

  private buildTimeline(trace: boolean[][]): Segment[] {
    const segs: Segment[] = [];
    let t = 0;
    const push = (kind: Segment['kind'], ms: number, extra: Partial<Segment> = {}, gate = -1) => {
      segs.push({ kind, t0: t, t1: t + ms, gate, ...extra });
      t += ms;
    };

    push('charge', 420);
    let x = SOURCE_X;
    let cleared = 0;

    for (let i = 0; i < trace.length; i++) {
      const s = this.speedAfter(cleared);
      const lanes = trace[i];
      push('run', 300 * s, { fromX: x, toX: this.approachX(i) }, i);
      x = this.approachX(i);
      lanes.forEach((live, lane) => push('fuse', 95 * s, { lane, live }, i));
      const passed = lanes.some(Boolean);
      if (passed) {
        push('open', 150 * s, {}, i);
        push('dash', 240 * s, { fromX: x, toX: this.throughX(i) }, i);
        x = this.throughX(i);
        cleared++;
        if (i === trace.length - 1) push('win', 1200, {}, i);
      } else {
        push('slam', 480, { fromX: x, toX: this.doorX(i) - DOOR_W / 2 - VOLT_R + 6 }, i);
        push('dazed', 800, {}, i);
        break;
      }
    }
    return segs;
  }

  // ---------- frame ----------

  private resize = (): void => {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = rect.width;
    this.height = rect.height;
    this.scale = rect.height / DESIGN_H;
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  private loop = (): void => {
    const now = performance.now();
    const dt = Math.min(50, now - (this.lastFrame || now));
    this.lastFrame = now;
    this.step(dt);
    this.draw(now);
    this.raf = requestAnimationFrame(this.loop);
  };

  private spawn(kind: Particle['kind'], x: number, y: number, n: number, color: string): void {
    if (this.reduceMotion) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = kind === 'firework' ? 3 + Math.random() * 4 : kind === 'smoke' ? 0.4 + Math.random() * 0.8 : 1.5 + Math.random() * 2.5;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp * (kind === 'spark' ? 0.6 : 1) - (kind === 'spark' ? 1.5 : 0),
        vy: Math.sin(a) * sp - (kind === 'smoke' ? 1.2 : kind === 'firework' ? 2 : 0.5),
        life: 1, max: 1,
        size: kind === 'smoke' ? 4 + Math.random() * 5 : kind === 'firework' ? 3 : 2.2,
        color, kind,
      });
    }
  }

  private step(dt: number): void {
    const k = dt / 16.7;
    this.particles = this.particles.filter((p) => {
      p.x += p.vx * k;
      p.y += p.vy * k;
      if (p.kind === 'smoke') { p.vy -= 0.02 * k; p.size += 0.18 * k; p.life -= 0.016 * k; }
      else if (p.kind === 'star') { p.life -= 0.01 * k; }
      else if (p.kind === 'firework') { p.vy += 0.09 * k; p.life -= 0.016 * k; }
      else { p.vy += 0.12 * k; p.life -= 0.04 * k; }
      return p.life > 0;
    });
    this.flash = Math.max(0, this.flash - dt / 380);
  }

  /** Resolve the live pose and door states from the timeline. */
  private state(now: number) {
    const pose = { x: SOURCE_X, y: 0, sx: 1, sy: 1, tilt: 0, mood: 'idle' as Mood, dir: 1, legs: 0, cool: false, look: 0 };
    const doors = this.lanes.map((k) => ({ open: 0, fuses: Array<'idle' | 'live' | 'dead'>(k).fill('idle'), failed: false, cleared: false, dim: false }));

    if (!this.anim) {
      const bob = Math.sin(now / 420);
      pose.y = Math.max(0, bob) * 6;
      pose.sy = 1 + bob * 0.03;
      pose.sx = 1 - bob * 0.03;
      pose.look = (Math.sin(now / 2300) + 1) / 2;
      return { pose, doors, activeGate: -1, cleared: 0, failedAt: -1 };
    }

    const elapsed = this.reduceMotion ? this.anim.total : now - this.anim.start;
    let cleared = 0;
    let failedAt = -1;
    let activeGate = -1;
    let x = SOURCE_X;

    for (const seg of this.anim.segments) {
      const started = elapsed >= seg.t0;
      const done = elapsed >= seg.t1;
      const p = clamp((elapsed - seg.t0) / (seg.t1 - seg.t0), 0, 1);
      if (!started) break;
      const key = `${seg.kind}${seg.gate}${seg.lane ?? ''}`;

      if (!this.anim.emitted.has(key)) {
        this.anim.emitted.add(key);
        if (seg.kind === 'charge') this.emit({ type: 'charge' });
        if (seg.kind === 'fuse') this.emit({ type: 'lane', live: Boolean(seg.live) });
        if (seg.kind === 'open') this.emit({ type: 'gate', index: seg.gate });
        if (seg.kind === 'slam') { this.emit({ type: 'failed', index: seg.gate }); this.flash = 1; this.flashColor = C.loss; this.shakeGate = seg.gate; this.shakeUntil = now + 420; }
        if (seg.kind === 'win') { this.emit({ type: 'won', gates: this.lanes.length }); this.flash = 0.8; this.flashColor = C.win; }
        if (seg.kind === 'fuse') {
          const d = this.doorX(seg.gate);
          const fy = GROUND_Y - DOOR_H + 22;
          const fx = d - ((this.lanes[seg.gate] - 1) * 18) / 2 + (seg.lane ?? 0) * 18;
          this.spawn(seg.live ? 'spark' : 'smoke', fx, fy, seg.live ? 6 : 4, seg.live ? C.brassBright : '#6a6a72');
        }
        if (seg.kind === 'slam') this.spawn('smoke', this.doorX(seg.gate) - DOOR_W / 2 - 10, GROUND_Y - 40, 10, '#8a8a92');
        if (seg.kind === 'win') for (let i = 0; i < 4; i++) this.spawn('firework', x + (Math.random() - 0.5) * 220, GROUND_Y - 130 - Math.random() * 90, 26, [C.brassBright, C.cta, C.win, '#ffffff'][i]);
      }

      activeGate = seg.gate;
      const door = doors[seg.gate];

      switch (seg.kind) {
        case 'charge':
          pose.mood = 'charge';
          pose.sx = 1 + Math.sin(p * Math.PI) * 0.22;
          pose.sy = 1 - Math.sin(p * Math.PI) * 0.22;
          pose.tilt = -0.12 * Math.sin(p * Math.PI);
          break;
        case 'run': {
          const e = ease.outCubic(p);
          x = lerp(seg.fromX!, seg.toX!, e);
          pose.mood = 'run';
          pose.legs = p * 6;
          pose.y = Math.abs(Math.sin(p * Math.PI * 3)) * 10;
          pose.sx = 1.08; pose.sy = 0.94; pose.tilt = 0.18;
          if (!done && Math.random() < 0.5) this.spawn('spark', x - 18, GROUND_Y - 8, 1, C.brassBright);
          break;
        }
        case 'fuse': {
          x = seg.fromX ?? x;
          pose.mood = 'brace';
          pose.sx = 0.94; pose.sy = 1.06;
          pose.tilt = (Math.random() - 0.5) * 0.04;
          if (door) door.fuses[seg.lane!] = done ? (seg.live ? 'live' : 'dead') : p > 0.55 ? (seg.live ? 'live' : 'dead') : 'idle';
          break;
        }
        case 'open':
          if (door) door.open = ease.outBack(p);
          pose.mood = 'happy';
          pose.y = Math.sin(p * Math.PI) * 14;
          pose.sy = 1 + Math.sin(p * Math.PI) * 0.12;
          break;
        case 'dash': {
          x = lerp(seg.fromX!, seg.toX!, ease.outCubic(p));
          if (door) door.open = 1;
          pose.mood = 'run';
          pose.legs = p * 5;
          pose.sx = 1.22; pose.sy = 0.86; pose.tilt = 0.28;
          if (!done) this.spawn('spark', x - 22, GROUND_Y - 12, 1, C.brassBright);
          if (done) { cleared = seg.gate + 1; if (door) door.cleared = true; }
          break;
        }
        case 'slam': {
          const hit = 0.32;
          if (p < hit) {
            x = lerp(seg.fromX!, seg.toX!, ease.inCubic(p / hit));
            pose.mood = 'run'; pose.sx = 1.25; pose.sy = 0.85; pose.tilt = 0.3; pose.legs = p * 8;
          } else {
            const q = (p - hit) / (1 - hit);
            x = lerp(seg.toX!, seg.toX! - 62, ease.outCubic(q));
            pose.mood = 'dazed';
            pose.sx = q < 0.15 ? 0.7 : lerp(0.7, 1.1, ease.outCubic(q));
            pose.sy = q < 0.15 ? 1.3 : lerp(1.3, 0.8, ease.outCubic(q));
            pose.y = Math.sin(Math.min(1, q * 1.6) * Math.PI) * 44;
            pose.tilt = -0.5 * ease.outCubic(q);
          }
          if (door) door.failed = true;
          failedAt = seg.gate;
          break;
        }
        case 'dazed':
          x = seg.fromX ?? x;
          pose.mood = 'dazed';
          pose.sx = 1.1; pose.sy = 0.8; pose.tilt = -0.5;
          if (door) door.failed = true;
          failedAt = seg.gate;
          if (Math.random() < 0.15) this.spawn('star', x + (Math.random() - 0.5) * 30, GROUND_Y - 70, 1, C.brassBright);
          break;
        case 'win':
          pose.mood = 'bow';
          pose.tilt = Math.sin(Math.min(1, p * 2) * Math.PI) * 0.9;
          pose.y = p < 0.5 ? Math.abs(Math.sin(p * Math.PI * 4)) * 26 : 0;
          break;
      }
      if (seg.kind === 'slam' || seg.kind === 'dazed') {
        const s = this.anim.segments.find((z) => z.kind === 'slam' && z.gate === seg.gate);
        if (s && seg.kind === 'dazed') x = s.toX! - 62;
      }
    }

    pose.x = x;
    pose.cool = cleared >= COOL_AT;
    for (let i = 0; i < doors.length; i++) {
      if (i < cleared) { doors[i].cleared = true; doors[i].open = 1; }
      if (failedAt !== -1 && i > failedAt) doors[i].dim = true;
    }
    return { pose, doors, activeGate, cleared, failedAt };
  }

  // ---------- drawing ----------

  private draw(now: number): void {
    const { ctx } = this;
    const { pose, doors, cleared, failedAt } = this.state(now);

    const viewW = this.viewW();
    const lastX = this.doorX(Math.max(0, this.lanes.length - 1)) + 170;
    const target = this.anim ? clamp(pose.x - viewW * 0.36, 0, Math.max(0, lastX - viewW)) : 0;
    this.camX += (target - this.camX) * 0.12;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.scale(dpr, dpr);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.save();
    ctx.scale(this.scale, this.scale);
    ctx.translate(-this.camX, 0);

    this.drawWall(viewW);
    this.drawFloor(viewW);
    this.drawConduit(now);
    this.drawSource(now);
    doors.forEach((d, i) => this.drawDoor(i, d, now, i === this.hover && !this.anim));
    this.drawVolt(pose, now);
    this.drawParticles();
    ctx.restore();

    if (this.flash > 0) {
      ctx.fillStyle = this.flashColor;
      ctx.globalAlpha = this.flash * 0.12;
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.globalAlpha = 1;
    }
    void cleared; void failedAt;
  }

  /** Machine housing behind the doors so the row reads as one apparatus, not props in a void. */
  private drawWall(viewW: number): void {
    const { ctx } = this;
    const x0 = this.camX - 50;
    const x1 = this.camX + viewW + 50;
    const top = -40;
    const rail = GROUND_Y - DOOR_H - 118;

    const g = ctx.createLinearGradient(0, top, 0, GROUND_Y);
    g.addColorStop(0, '#0a0a0e');
    g.addColorStop(0.45, '#0f0f14');
    g.addColorStop(1, '#141419');
    ctx.fillStyle = g;
    ctx.fillRect(x0, top, x1 - x0, GROUND_Y - top);

    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (let x = Math.floor(x0 / 8) * 8; x < x1; x += 8) {
      for (let y = Math.floor(top / 8) * 8; y < GROUND_Y; y += 8) ctx.fillRect(x + ((y / 8) % 2) * 4, y, 1, 1);
    }

    ctx.fillStyle = '#0a0a0d';
    ctx.fillRect(x0, rail - 2, x1 - x0, 2);
    ctx.fillStyle = C.brass;
    ctx.fillRect(x0, rail, x1 - x0, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(x0, rail + 3, x1 - x0, 1);

    // hazard stripe along the skirting
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, GROUND_Y - 14, x1 - x0, 12);
    ctx.clip();
    ctx.fillStyle = '#1c1a12';
    ctx.fillRect(x0, GROUND_Y - 14, x1 - x0, 12);
    ctx.fillStyle = 'rgba(217,180,90,0.32)';
    for (let x = Math.floor(x0 / 28) * 28; x < x1; x += 28) {
      ctx.beginPath();
      ctx.moveTo(x, GROUND_Y - 2);
      ctx.lineTo(x + 12, GROUND_Y - 14);
      ctx.lineTo(x + 24, GROUND_Y - 14);
      ctx.lineTo(x + 12, GROUND_Y - 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // stencil
    ctx.font = 'italic 800 54px "Poppins", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    for (let x = Math.floor(x0 / 1400) * 1400; x < x1; x += 1400) ctx.fillText('APPARATUS', x + 340, rail - 22);
  }

  /** Cable run joining the doors — the wires the player just spent. */
  private drawConduit(now: number): void {
    const { ctx } = this;
    if (this.lanes.length === 0) return;
    const y = GROUND_Y - DOOR_H - 92;
    const x0 = SOURCE_X - 89;
    const x1 = this.doorX(this.lanes.length - 1);
    ctx.strokeStyle = '#26272f';
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.strokeStyle = C.brass;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    for (let i = 0; i < this.lanes.length; i++) {
      const dx = this.doorX(i);
      ctx.fillStyle = C.frame;
      this.roundRect(dx - 9, y - 7, 18, 14, 4); ctx.fill();
      ctx.fillStyle = C.brass;
      ctx.fillRect(dx - 2, y + 7, 4, 84);
    }
    if (this.anim && !this.reduceMotion) {
      const t = (now / 900) % 1;
      ctx.fillStyle = C.brassBright;
      ctx.shadowColor = C.brassBright; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(lerp(x0, x1, t), y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  private drawFloor(viewW: number): void {
    const { ctx } = this;
    const x0 = this.camX - 50;
    const x1 = this.camX + viewW + 50;
    ctx.fillStyle = C.floor;
    ctx.fillRect(x0, GROUND_Y, x1 - x0, DESIGN_H - GROUND_Y);
    ctx.fillStyle = C.floorEdge;
    ctx.fillRect(x0, GROUND_Y, x1 - x0, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let x = Math.floor(x0 / 40) * 40; x < x1; x += 40) ctx.fillRect(x, GROUND_Y + 14, 22, 2);
  }

  private drawSource(now: number): void {
    const { ctx } = this;
    const pulse = (Math.sin(now / 500) + 1) / 2;
    ctx.fillStyle = C.frame;
    this.roundRect(SOURCE_X - 46, GROUND_Y - 12, 92, 12, 4);
    ctx.fill();
    ctx.fillStyle = C.brass;
    ctx.fillRect(SOURCE_X - 46, GROUND_Y - 12, 92, 2);
    ctx.fillStyle = C.brass;
    ctx.fillRect(SOURCE_X - 92, GROUND_Y - 150, 6, 138);
    ctx.beginPath();
    ctx.arc(SOURCE_X - 89, GROUND_Y - 156, 11, 0, Math.PI * 2);
    ctx.fillStyle = C.brassBright;
    ctx.shadowColor = C.brassBright;
    ctx.shadowBlur = 10 + pulse * 14;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  private drawDoor(i: number, d: { open: number; fuses: ('idle' | 'live' | 'dead')[]; failed: boolean; cleared: boolean; dim: boolean }, now: number, hovered: boolean): void {
    const { ctx } = this;
    const dx = this.doorX(i);
    const top = GROUND_Y - DOOR_H;
    const shake = this.shakeGate === i && now < this.shakeUntil ? (Math.random() - 0.5) * 6 : 0;

    ctx.save();
    ctx.translate(shake, 0);
    ctx.globalAlpha = d.dim ? 0.32 : 1;

    // doorway interior, warm when the door has opened
    const inner = { x: dx - DOOR_W / 2 + 10, y: top + 32, w: DOOR_W - 20, h: DOOR_H - 32 };
    const glow = ctx.createLinearGradient(0, inner.y, 0, GROUND_Y);
    glow.addColorStop(0, d.open > 0 ? `rgba(255,190,90,${0.05 + d.open * 0.22})` : 'rgba(0,0,0,0.6)');
    glow.addColorStop(1, d.open > 0 ? `rgba(255,150,60,${0.02 + d.open * 0.1})` : 'rgba(0,0,0,0.85)');
    ctx.fillStyle = glow;
    ctx.fillRect(inner.x, inner.y, inner.w, inner.h);

    // the door itself slides up into the lintel
    const openPx = d.open * (DOOR_H - 34);
    ctx.save();
    ctx.beginPath();
    ctx.rect(inner.x, inner.y, inner.w, inner.h);
    ctx.clip();
    const py = inner.y - openPx;
    const panel = ctx.createLinearGradient(inner.x, 0, inner.x + inner.w, 0);
    panel.addColorStop(0, '#1e2028');
    panel.addColorStop(0.5, '#262932');
    panel.addColorStop(1, '#1a1c23');
    ctx.fillStyle = panel;
    ctx.fillRect(inner.x, py, inner.w, inner.h);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(inner.x + 8, py + 10, inner.w - 16, 2);
    ctx.fillRect(inner.x + 8, py + inner.h - 22, inner.w - 16, 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 2;
    ctx.strokeRect(inner.x + 8.5, py + 22.5, inner.w - 17, inner.h - 56);
    // latch plate
    ctx.fillStyle = d.failed ? C.loss : C.brass;
    this.roundRect(dx - 13, py + inner.h / 2 - 9, 26, 18, 4); ctx.fill();
    ctx.fillStyle = '#0d0d11';
    ctx.beginPath(); ctx.arc(dx, py + inner.h / 2, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // frame
    ctx.fillStyle = C.frame;
    this.roundRect(dx - DOOR_W / 2, top, 10, DOOR_H, 3); ctx.fill();
    this.roundRect(dx + DOOR_W / 2 - 10, top, 10, DOOR_H, 3); ctx.fill();
    this.roundRect(dx - DOOR_W / 2 - 4, top - 6, DOOR_W + 8, 38, 6); ctx.fill();
    ctx.fillStyle = d.failed ? C.loss : d.cleared ? C.brassBright : hovered ? C.brassBright : C.brass;
    ctx.fillRect(dx - DOOR_W / 2 - 4, top - 6, DOOR_W + 8, 2);
    ctx.fillRect(dx - DOOR_W / 2, top + 30, 10, 2);
    ctx.fillRect(dx + DOOR_W / 2 - 10, top + 30, 10, 2);

    // fuses on the lintel
    const k = d.fuses.length;
    const fy = top + 16;
    for (let f = 0; f < k; f++) {
      const fx = dx - ((k - 1) * 18) / 2 + f * 18;
      const s = d.fuses[f];
      ctx.fillStyle = s === 'live' ? C.fuseLive : s === 'dead' ? C.fuseDead : C.fuseIdle;
      if (s === 'live') { ctx.shadowColor = C.fuseLive; ctx.shadowBlur = 12; }
      this.roundRect(fx - 6, fy - 5, 12, 10, 3);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (s === 'dead') { ctx.strokeStyle = '#5a2a2a'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(fx - 4, fy - 3); ctx.lineTo(fx + 4, fy + 3); ctx.moveTo(fx + 4, fy - 3); ctx.lineTo(fx - 4, fy + 3); ctx.stroke(); }
      if (s === 'idle' && !this.anim) { ctx.fillStyle = `rgba(255,224,104,${0.25 + ((Math.sin(now / 700 + i + f) + 1) / 2) * 0.35})`; this.roundRect(fx - 6, fy - 5, 12, 10, 3); ctx.fill(); }
    }

    // multiplier chip
    const label = this.labels[i];
    if (label) {
      ctx.font = `700 15px "Chakra Petch", "Rubik", sans-serif`;
      const w = ctx.measureText(label).width + 20;
      const cy = top - 26;
      ctx.fillStyle = 'rgba(8,8,11,0.92)';
      this.roundRect(dx - w / 2, cy - 14, w, 28, 7); ctx.fill();
      ctx.strokeStyle = d.failed ? C.loss : d.cleared ? C.brass : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      this.roundRect(dx - w / 2 + 0.5, cy - 13.5, w - 1, 27, 7); ctx.stroke();
      ctx.fillStyle = d.failed ? C.loss : d.cleared ? C.brassBright : 'rgba(255,255,255,0.8)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, dx, cy + 1);
      ctx.font = `600 9px "Rubik", sans-serif`;
      ctx.fillStyle = C.textDim;
      ctx.fillText(`GATE ${i + 1}`, dx, cy - 23);
    }

    ctx.restore();
  }

  private drawVolt(p: { x: number; y: number; sx: number; sy: number; tilt: number; mood: Mood; legs: number; cool: boolean; look: number }, now: number): void {
    const { ctx } = this;
    const cx = p.x;
    const cy = GROUND_Y - VOLT_R - p.y;
    const blink = now > this.blinkAt && now < this.blinkAt + 110;
    if (now > this.blinkAt + 110) this.blinkAt = now + 2400 + Math.random() * 2200;

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(cx, GROUND_Y - 2, VOLT_R * 0.95 * p.sx, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(p.tilt);
    ctx.scale(p.sx, p.sy);

    // feet
    const stride = p.mood === 'run' ? Math.sin(p.legs * Math.PI) * 10 : 0;
    ctx.fillStyle = C.ink;
    ctx.beginPath(); ctx.ellipse(-11 + stride, VOLT_R - 2, 9, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(11 - stride, VOLT_R - 2, 9, 5, 0, 0, Math.PI * 2); ctx.fill();

    // body: teardrop with a bolt crest
    const grad = ctx.createRadialGradient(-8, -10, 4, 0, 0, VOLT_R + 8);
    grad.addColorStop(0, '#fff3b0');
    grad.addColorStop(0.55, C.brassBright);
    grad.addColorStop(1, '#f2a13a');
    ctx.fillStyle = grad;
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -VOLT_R - 14);
    ctx.bezierCurveTo(VOLT_R * 0.9, -VOLT_R - 6, VOLT_R + 2, VOLT_R * 0.2, VOLT_R * 0.7, VOLT_R * 0.75);
    ctx.bezierCurveTo(VOLT_R * 0.35, VOLT_R + 2, -VOLT_R * 0.35, VOLT_R + 2, -VOLT_R * 0.7, VOLT_R * 0.75);
    ctx.bezierCurveTo(-VOLT_R - 2, VOLT_R * 0.2, -VOLT_R * 0.9, -VOLT_R - 6, 0, -VOLT_R - 14);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // crest: a little bolt that flickers
    const flick = p.mood === 'charge' || p.mood === 'run' ? 1 + Math.random() * 0.5 : 1;
    ctx.fillStyle = '#fff6c8';
    ctx.beginPath();
    ctx.moveTo(2, -VOLT_R - 12);
    ctx.lineTo(10 * flick, -VOLT_R - 26 * flick);
    ctx.lineTo(4, -VOLT_R - 24 * flick);
    ctx.lineTo(9 * flick, -VOLT_R - 38 * flick);
    ctx.lineTo(-2, -VOLT_R - 22 * flick);
    ctx.lineTo(3, -VOLT_R - 22 * flick);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // eyes
    const ex = 10;
    const ey = -6;
    const lookX = p.mood === 'idle' ? (p.look - 0.5) * 5 : 2.5;
    const lookY = p.mood === 'charge' ? 1 : 0;
    for (const side of [-1, 1]) {
      const x = side * ex;
      if (p.mood === 'dazed') {
        ctx.strokeStyle = C.ink; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x - 5, ey - 5); ctx.lineTo(x + 5, ey + 5); ctx.moveTo(x + 5, ey - 5); ctx.lineTo(x - 5, ey + 5); ctx.stroke();
        continue;
      }
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      if (blink || p.mood === 'happy' || p.mood === 'bow') { ctx.ellipse(x, ey, 7.5, p.mood === 'happy' || p.mood === 'bow' ? 3 : 1.2, 0, 0, Math.PI * 2); }
      else if (p.mood === 'charge' || p.mood === 'brace') { ctx.ellipse(x, ey, 7.5, 5, 0, 0, Math.PI * 2); }
      else ctx.ellipse(x, ey, 7.5, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      if (!(blink || p.mood === 'happy' || p.mood === 'bow')) {
        ctx.fillStyle = C.ink;
        ctx.beginPath(); ctx.arc(x + lookX, ey + lookY, 3.4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(x + lookX + 1.2, ey + lookY - 1.4, 1.1, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (p.cool && p.mood !== 'dazed') {
      ctx.fillStyle = C.ink;
      this.roundRect(-ex - 9, ey - 5, 17, 9, 3); ctx.fill();
      this.roundRect(ex - 8, ey - 5, 17, 9, 3); ctx.fill();
      ctx.fillRect(-2, ey - 2, 4, 2);
    }

    // mouth
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    if (p.mood === 'happy' || p.mood === 'bow' || p.cool) ctx.arc(0, 8, 9, 0.15 * Math.PI, 0.85 * Math.PI);
    else if (p.mood === 'brace' || p.mood === 'charge') ctx.arc(0, 12, 4, 0, Math.PI * 2);
    else if (p.mood === 'dazed') { ctx.moveTo(-7, 13); ctx.quadraticCurveTo(0, 8, 7, 13); }
    else ctx.arc(0, 9, 6, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();

    ctx.restore();
  }

  private drawParticles(): void {
    const { ctx } = this;
    for (const p of this.particles) {
      ctx.globalAlpha = clamp(p.life, 0, 1) * (p.kind === 'smoke' ? 0.5 : 1);
      ctx.fillStyle = p.color;
      if (p.kind === 'star') {
        ctx.font = '700 12px "Chakra Petch", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('★', p.x, p.y);
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
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
