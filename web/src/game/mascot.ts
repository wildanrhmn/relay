/**
 * Volt — the current, as a character.
 *
 * Each gate is an airlock door with its wires as fuses in the box above it.
 * Volt runs up, the fuses test one by one, any live fuse throws the breaker
 * and the leaves part; a door whose fuses all blow stays shut and Volt runs
 * into it. How far Volt gets is what the round pays on, so the punchline and
 * the payout are the same moment.
 *
 * Everything is drawn in code so nothing is blocked on an asset; the timeline
 * here is what a Rive or sprite version would plug into later.
 */
import type { StageEvent, StageLike } from './stage-api';

const DESIGN_H = 560;
/** Narrow (portrait) stages frame by width instead, so at least this much of the row is visible. */
const MIN_VIEW_W = 640;
const GROUND_Y = 468;
const SOURCE_X = 96;
const FIRST_DOOR_X = 340;
const DOOR_GAP = 244;
const DOOR_W = 124;
const DOOR_H = 212;
const FRAME = 12;
const VOLT_R = 30;
const COOL_AT = 7;

const C = {
  bg: '#0b0b0e',
  floor: '#101014',
  floorEdge: '#c9a24f',
  steel: '#1e2027',
  steelHi: '#2c2f38',
  steelLo: '#15161b',
  brass: '#d9b45a',
  brassBright: '#ffe068',
  ink: '#1a1408',
  fuseIdle: '#3a3320',
  fuseLive: '#ffe068',
  fuseDead: '#221010',
  loss: '#ff3838',
  win: '#08d42f',
  cta: '#cf68ff',
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

type Particle = { x: number; y: number; vx: number; vy: number; life: number; size: number; color: string; kind: 'spark' | 'smoke' | 'star' | 'firework' };

type Pose = { x: number; y: number; sx: number; sy: number; tilt: number; mood: Mood; legs: number; cool: boolean; look: number; footTap: number };
type DoorState = { open: number; fuses: ('idle' | 'live' | 'dead')[]; failed: boolean; cleared: boolean; dim: boolean };

const ease = {
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  inCubic: (t: number) => t * t * t,
  outBack: (t: number) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2),
  inOut: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class MascotStage implements StageLike {
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private width = 0;
  private height = 0;
  private scale = 1;
  private offsetY = 0;

  private lanes: number[] = [];
  private labels: string[] = [];
  private hover = -1;

  private camX = 0;
  private camShake = 0;
  private particles: Particle[] = [];
  private lastFrame = 0;
  private blinkAt = 0;
  private flash = 0;
  private flashColor = C.loss;
  private lastFirework = 0;

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

  private doorX = (i: number) => FIRST_DOOR_X + i * DOOR_GAP;
  private approachX = (i: number) => this.doorX(i) - 78;
  private throughX = (i: number) => this.doorX(i) + 86;
  private viewW = () => this.width / this.scale;

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
    const wy = (y - this.offsetY) / this.scale;
    for (let i = 0; i < this.lanes.length; i++) {
      const dx = this.doorX(i);
      if (wx >= dx - DOOR_W / 2 - 14 && wx <= dx + DOOR_W / 2 + 14 && wy >= GROUND_Y - DOOR_H - 60 && wy <= GROUND_Y) return i;
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
      if (lanes.some(Boolean)) {
        push('open', 170 * s, {}, i);
        push('dash', 240 * s, { fromX: x, toX: this.throughX(i) }, i);
        x = this.throughX(i);
        cleared++;
        if (i === trace.length - 1) push('win', trace.length >= 10 ? 2400 : 1500, {}, i);
      } else {
        push('slam', 700, { fromX: x, toX: this.doorX(i) - DOOR_W / 2 - VOLT_R + 8 }, i);
        push('dazed', 900, {}, i);
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
    this.scale = Math.min(rect.height / DESIGN_H, rect.width / MIN_VIEW_W);
    // Sit the scene low in a tall frame so the labels keep headroom.
    this.offsetY = Math.max(0, rect.height - DESIGN_H * this.scale) * 0.62;
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
      const sp = kind === 'firework' ? 3 + Math.random() * 4.5 : kind === 'smoke' ? 0.4 + Math.random() * 0.8 : 1.5 + Math.random() * 2.5;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * sp * (kind === 'spark' ? 0.6 : 1) - (kind === 'spark' ? 1.5 : 0),
        vy: Math.sin(a) * sp - (kind === 'smoke' ? 1.2 : kind === 'firework' ? 2.2 : 0.5),
        life: 1,
        size: kind === 'smoke' ? 4 + Math.random() * 5 : kind === 'firework' ? 3.4 : 2.2,
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
      else if (p.kind === 'firework') { p.vy += 0.075 * k; p.life -= 0.0095 * k; }
      else { p.vy += 0.12 * k; p.life -= 0.04 * k; }
      return p.life > 0;
    });
    this.flash = Math.max(0, this.flash - dt / 380);
    this.camShake = Math.max(0, this.camShake - dt / 300);
  }

  /** Resolve the live pose and door states from the timeline. */
  private state(now: number) {
    const pose: Pose = { x: SOURCE_X, y: 0, sx: 1, sy: 1, tilt: 0, mood: 'idle', legs: 0, cool: false, look: 0.5, footTap: 0 };
    const doors: DoorState[] = this.lanes.map((k) => ({ open: 0, fuses: Array<'idle' | 'live' | 'dead'>(k).fill('idle'), failed: false, cleared: false, dim: false }));

    if (!this.anim) {
      // Idle life: a breathing bob, a foot tap, and every few seconds a glance
      // down the row followed by a little shrug.
      const bob = Math.sin(now / 420);
      pose.y = Math.max(0, bob) * 5;
      pose.sy = 1 + bob * 0.03;
      pose.sx = 1 - bob * 0.03;
      const tap = (now / 1600) % 1;
      pose.footTap = tap < 0.12 ? Math.sin((tap / 0.12) * Math.PI) : 0;
      const cycle = (now / 5200) % 1;
      if (cycle > 0.55 && cycle < 0.78) { pose.look = 1; pose.tilt = 0.07; }
      else if (cycle >= 0.78 && cycle < 0.9) {
        const q = (cycle - 0.78) / 0.12;
        const s = Math.sin(q * Math.PI);
        pose.look = 0.5; pose.sy = 1 + s * 0.12; pose.sx = 1 - s * 0.08; pose.tilt = Math.sin(q * Math.PI * 2) * 0.08; pose.y += s * 6;
      }
      return { pose, doors, cleared: 0, failedAt: -1 };
    }

    const elapsed = this.reduceMotion ? this.anim.total : now - this.anim.start;
    let cleared = 0;
    let failedAt = -1;
    let x = SOURCE_X;

    for (const seg of this.anim.segments) {
      if (elapsed < seg.t0) break;
      const done = elapsed >= seg.t1;
      const p = clamp((elapsed - seg.t0) / (seg.t1 - seg.t0), 0, 1);
      const key = `${seg.kind}${seg.gate}${seg.lane ?? ''}`;
      const door = doors[seg.gate];

      if (!this.anim.emitted.has(key)) {
        this.anim.emitted.add(key);
        if (seg.kind === 'charge') this.emit({ type: 'charge' });
        if (seg.kind === 'fuse') {
          this.emit({ type: 'lane', live: Boolean(seg.live) });
          const k = this.lanes[seg.gate];
          const fx = this.doorX(seg.gate) - ((k - 1) * 18) / 2 + (seg.lane ?? 0) * 18;
          const fy = GROUND_Y - DOOR_H - 22;
          this.spawn(seg.live ? 'spark' : 'smoke', fx, fy, seg.live ? 6 : 4, seg.live ? C.brassBright : '#6a6a72');
        }
        if (seg.kind === 'open') this.emit({ type: 'gate', index: seg.gate });
        if (seg.kind === 'win') { this.emit({ type: 'won', gates: this.lanes.length }); this.flash = 0.8; this.flashColor = C.win; }
      }

      switch (seg.kind) {
        case 'charge':
          pose.mood = 'charge';
          pose.sx = 1 + Math.sin(p * Math.PI) * 0.22;
          pose.sy = 1 - Math.sin(p * Math.PI) * 0.22;
          pose.tilt = -0.12 * Math.sin(p * Math.PI);
          break;
        case 'run':
          x = lerp(seg.fromX!, seg.toX!, ease.outCubic(p));
          pose.mood = 'run'; pose.legs = p * 6;
          pose.y = Math.abs(Math.sin(p * Math.PI * 3)) * 10;
          pose.sx = 1.08; pose.sy = 0.94; pose.tilt = 0.18;
          if (!done && Math.random() < 0.5) this.spawn('spark', x - 18, GROUND_Y - 8, 1, C.brassBright);
          break;
        case 'fuse':
          x = seg.fromX ?? x;
          pose.mood = 'brace'; pose.sx = 0.94; pose.sy = 1.06;
          pose.tilt = (Math.random() - 0.5) * 0.04;
          if (door) door.fuses[seg.lane!] = done || p > 0.55 ? (seg.live ? 'live' : 'dead') : 'idle';
          break;
        case 'open':
          if (door) door.open = ease.outBack(p);
          pose.mood = 'happy';
          pose.y = Math.sin(p * Math.PI) * 14;
          pose.sy = 1 + Math.sin(p * Math.PI) * 0.12;
          break;
        case 'dash':
          x = lerp(seg.fromX!, seg.toX!, ease.outCubic(p));
          if (door) door.open = 1;
          pose.mood = 'run'; pose.legs = p * 5;
          pose.sx = 1.22; pose.sy = 0.86; pose.tilt = 0.28;
          if (!done) this.spawn('spark', x - 22, GROUND_Y - 12, 1, C.brassBright);
          if (done) { cleared = seg.gate + 1; if (door) door.cleared = true; }
          break;
        case 'slam': {
          // Anticipation (sprint) → impact squash + hit-stop → knockback arc with
          // two bounces → lands on his back. Camera kicks on the hit.
          const hitAt = 0.26;
          const stopEnd = 0.36;
          if (p < hitAt) {
            x = lerp(seg.fromX!, seg.toX!, ease.inCubic(p / hitAt));
            pose.mood = 'run'; pose.sx = 1.28; pose.sy = 0.84; pose.tilt = 0.32; pose.legs = p * 9;
          } else if (p < stopEnd) {
            x = seg.toX!;
            pose.mood = 'dazed'; pose.sx = 0.58; pose.sy = 1.4; pose.tilt = 0.1;
            if (!this.anim.emitted.has(`hit${seg.gate}`)) {
              this.anim.emitted.add(`hit${seg.gate}`);
              this.emit({ type: 'failed', index: seg.gate });
              this.flash = 1; this.flashColor = C.loss; this.camShake = 1;
              this.spawn('spark', seg.toX! + VOLT_R, GROUND_Y - VOLT_R, 10, C.brassBright);
              this.spawn('smoke', seg.toX! + VOLT_R - 6, GROUND_Y - VOLT_R + 4, 8, '#8a8a92');
            }
          } else {
            const q = (p - stopEnd) / (1 - stopEnd);
            x = lerp(seg.toX!, seg.toX! - 96, ease.outCubic(q));
            const bounce = Math.abs(Math.sin(q * Math.PI * 2.4)) * Math.pow(1 - q, 1.4);
            pose.y = bounce * 74;
            pose.mood = 'dazed';
            pose.tilt = lerp(0.1, -2.5, ease.outCubic(Math.min(1, q * 1.3)));
            pose.sx = 1 + bounce * 0.15; pose.sy = 1 - bounce * 0.15;
            if (q > 0.97) { pose.sx = 1.1; pose.sy = 0.86; }
          }
          if (door) door.failed = true;
          failedAt = seg.gate;
          break;
        }
        case 'dazed': {
          const s = this.anim.segments.find((z) => z.kind === 'slam' && z.gate === seg.gate);
          x = (s?.toX ?? x) - 96;
          pose.mood = 'dazed'; pose.tilt = -2.5 + Math.sin(now / 260) * 0.04;
          pose.sx = 1.1; pose.sy = 0.86;
          pose.footTap = ((now / 700) % 1) < 0.2 ? 1 : 0;
          if (door) door.failed = true;
          failedAt = seg.gate;
          break;
        }
        case 'win': {
          pose.mood = 'bow';
          const bows = this.lanes.length >= 10 ? 2 : 1;
          pose.tilt = Math.sin(Math.min(1, p * (bows + 0.5)) * Math.PI * bows) * 0.9;
          pose.y = p < 0.5 ? Math.abs(Math.sin(p * Math.PI * 4)) * 26 : 0;
          if (!done && now - this.lastFirework > (this.lanes.length >= 10 ? 130 : 200) && p < 0.85) {
            this.lastFirework = now;
            const spread = this.viewW() * 0.9;
            this.spawn('firework', x - spread * 0.55 + Math.random() * spread, GROUND_Y - 120 - Math.random() * 110, 34, [C.brassBright, C.cta, C.win, '#ffffff'][Math.floor(Math.random() * 4)]);
          }
          break;
        }
      }
    }

    pose.x = x;
    pose.cool = cleared >= COOL_AT;
    for (let i = 0; i < doors.length; i++) {
      if (i < cleared) { doors[i].cleared = true; doors[i].open = 1; }
      if (failedAt !== -1 && i > failedAt) doors[i].dim = true;
    }
    return { pose, doors, cleared, failedAt };
  }

  // ---------- drawing ----------

  private draw(now: number): void {
    const { ctx } = this;
    const { pose, doors } = this.state(now);

    const viewW = this.viewW();
    const lastX = this.doorX(Math.max(0, this.lanes.length - 1)) + 180;
    const target = this.anim ? clamp(pose.x - viewW * 0.36, 0, Math.max(0, lastX - viewW)) : 0;
    this.camX += (target - this.camX) * 0.12;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.width, this.height);

    const kick = this.reduceMotion ? 0 : this.camShake * 9;
    ctx.save();
    ctx.translate((Math.random() - 0.5) * kick, this.offsetY + (Math.random() - 0.5) * kick * 0.6);
    ctx.scale(this.scale, this.scale);
    ctx.translate(-this.camX, 0);

    this.drawWall(viewW);
    this.drawFloor(viewW);
    this.drawConduit();
    this.drawSource();
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
  }

  /** Housing behind the doors. Quiet on purpose: one gradient, one texture, no rails. */
  private drawWall(viewW: number): void {
    const { ctx } = this;
    const x0 = this.camX - 60;
    const x1 = this.camX + viewW + 60;

    const top = -this.offsetY / this.scale - 40;
    const g = ctx.createLinearGradient(0, top, 0, GROUND_Y);
    g.addColorStop(0, '#090a0d');
    g.addColorStop(0.55, '#0e0f14');
    g.addColorStop(1, '#141419');
    ctx.fillStyle = g;
    ctx.fillRect(x0, top, x1 - x0, GROUND_Y - top);

    ctx.fillStyle = 'rgba(255,255,255,0.032)';
    for (let x = Math.floor(x0 / 8) * 8; x < x1; x += 8) {
      for (let y = Math.floor(top / 8) * 8; y < GROUND_Y; y += 8) ctx.fillRect(x + ((y / 8) % 2) * 4, y, 1, 1);
    }

    // a soft pool of light over each door
    for (let i = 0; i < this.lanes.length; i++) {
      const dx = this.doorX(i);
      const r = ctx.createRadialGradient(dx, GROUND_Y - DOOR_H * 0.5, 10, dx, GROUND_Y - DOOR_H * 0.5, 220);
      r.addColorStop(0, 'rgba(255,220,140,0.05)');
      r.addColorStop(1, 'rgba(255,220,140,0)');
      ctx.fillStyle = r;
      ctx.fillRect(dx - 220, GROUND_Y - DOOR_H - 120, 440, DOOR_H + 120);
    }

    // hazard stripe along the skirting
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, GROUND_Y - 14, x1 - x0, 12);
    ctx.clip();
    ctx.fillStyle = '#1c1a12';
    ctx.fillRect(x0, GROUND_Y - 14, x1 - x0, 12);
    ctx.fillStyle = 'rgba(217,180,90,0.3)';
    for (let x = Math.floor(x0 / 28) * 28; x < x1; x += 28) {
      ctx.beginPath();
      ctx.moveTo(x, GROUND_Y - 2); ctx.lineTo(x + 12, GROUND_Y - 14); ctx.lineTo(x + 24, GROUND_Y - 14); ctx.lineTo(x + 12, GROUND_Y - 2);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  /** One cable feeding the fuse boxes, low contrast, running behind them. */
  private drawConduit(): void {
    const { ctx } = this;
    if (this.lanes.length === 0) return;
    const y = GROUND_Y - DOOR_H - 22;
    const x0 = this.doorX(0) - 60;
    const x1 = this.doorX(this.lanes.length - 1);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1d1e25';
    ctx.lineWidth = 9;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.strokeStyle = 'rgba(217,180,90,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  }

  private drawFloor(viewW: number): void {
    const { ctx } = this;
    const x0 = this.camX - 60;
    const x1 = this.camX + viewW + 60;
    ctx.fillStyle = C.floor;
    ctx.fillRect(x0, GROUND_Y, x1 - x0, (this.height - this.offsetY) / this.scale - GROUND_Y + 40);
    ctx.fillStyle = C.floorEdge;
    ctx.fillRect(x0, GROUND_Y, x1 - x0, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let x = Math.floor(x0 / 40) * 40; x < x1; x += 40) ctx.fillRect(x, GROUND_Y + 14, 22, 2);
  }

  private drawSource(): void {
    const { ctx } = this;
    ctx.fillStyle = C.steel;
    this.roundRect(SOURCE_X - 46, GROUND_Y - 12, 92, 12, 4); ctx.fill();
    ctx.fillStyle = C.brass;
    ctx.fillRect(SOURCE_X - 46, GROUND_Y - 12, 92, 2);
  }

  /** Arch-shaped doorway path: a rectangle with a semicircular top. */
  private archPath(cx: number, bottom: number, w: number, h: number): void {
    const { ctx } = this;
    const r = w / 2;
    ctx.beginPath();
    ctx.moveTo(cx - r, bottom);
    ctx.lineTo(cx - r, bottom - h + r);
    ctx.arc(cx, bottom - h + r, r, Math.PI, 0);
    ctx.lineTo(cx + r, bottom);
    ctx.closePath();
  }

  private drawDoor(i: number, d: DoorState, now: number, hovered: boolean): void {
    const { ctx } = this;
    const dx = this.doorX(i);
    const top = GROUND_Y - DOOR_H;
    const innerW = DOOR_W - FRAME * 2;
    const innerH = DOOR_H - FRAME;
    const accent = d.failed ? C.loss : d.cleared || hovered ? C.brassBright : C.brass;

    ctx.save();
    ctx.globalAlpha = d.dim ? 0.32 : 1;

    // frame body with a brass inner trim
    const frameGrad = ctx.createLinearGradient(dx - DOOR_W / 2, 0, dx + DOOR_W / 2, 0);
    frameGrad.addColorStop(0, C.steelLo);
    frameGrad.addColorStop(0.5, C.steelHi);
    frameGrad.addColorStop(1, C.steelLo);
    ctx.fillStyle = frameGrad;
    this.archPath(dx, GROUND_Y, DOOR_W, DOOR_H);
    ctx.fill();
    ctx.strokeStyle = '#08080b';
    ctx.lineWidth = 2;
    ctx.stroke();

    // interior: black when shut, warm when powered
    ctx.save();
    this.archPath(dx, GROUND_Y, innerW, innerH);
    ctx.clip();
    const glow = ctx.createLinearGradient(0, top, 0, GROUND_Y);
    glow.addColorStop(0, d.open > 0 ? `rgba(255,196,96,${0.08 + d.open * 0.3})` : '#050506');
    glow.addColorStop(1, d.open > 0 ? `rgba(255,150,60,${0.03 + d.open * 0.12})` : '#0a0a0c');
    ctx.fillStyle = glow;
    ctx.fillRect(dx - innerW / 2, top, innerW, innerH + 4);

    // two leaves parting sideways
    const shift = d.open * (innerW / 2 + 4);
    for (const side of [-1, 1]) {
      const lx = side < 0 ? dx - innerW / 2 - shift : dx + shift;
      const leaf = ctx.createLinearGradient(lx, 0, lx + innerW / 2, 0);
      leaf.addColorStop(0, side < 0 ? '#20222a' : '#262932');
      leaf.addColorStop(1, side < 0 ? '#262932' : '#1c1e25');
      ctx.fillStyle = leaf;
      ctx.fillRect(lx, top, innerW / 2, innerH + 4);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(lx + 6, top + 26, innerW / 2 - 12, 1.5);
      ctx.fillRect(lx + 6, GROUND_Y - 30, innerW / 2 - 12, 1.5);
      // porthole
      const px = lx + innerW / 4;
      const py = top + innerH * 0.42;
      ctx.fillStyle = C.brass;
      ctx.beginPath(); ctx.arc(px, py, 13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = d.failed ? '#4a1414' : d.open > 0 ? `rgba(255,200,110,${0.4 + d.open * 0.6})` : '#0c0d12';
      ctx.beginPath(); ctx.arc(px, py, 9.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath(); ctx.arc(px - 3, py - 3, 3, 0, Math.PI * 2); ctx.fill();
    }
    // seam
    ctx.fillStyle = '#08080b';
    ctx.fillRect(dx - 1 - shift, top, 2, innerH + 4);
    ctx.fillRect(dx - 1 + shift, top, 2, innerH + 4);
    ctx.restore();

    // brass trim on the inner edge
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    this.archPath(dx, GROUND_Y, innerW + 3, innerH + 1.5);
    ctx.stroke();

    // rivets down both sides
    ctx.fillStyle = '#3a3d47';
    for (let y = top + DOOR_W / 2 + 8; y < GROUND_Y - 10; y += 22) {
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.arc(dx + side * (DOOR_W / 2 - FRAME / 2), y, 2.2, 0, Math.PI * 2); ctx.fill();
      }
    }

    // breaker lever on the right jamb: down when shut, thrown up when powered
    const lvX = dx + DOOR_W / 2 + 9;
    const lvY = top + innerH * 0.5;
    const angle = lerp(0.65, -0.65, d.open);
    ctx.fillStyle = C.steelHi;
    this.roundRect(lvX - 7, lvY - 14, 14, 28, 4); ctx.fill();
    ctx.save();
    ctx.translate(lvX, lvY);
    ctx.rotate(angle);
    ctx.fillStyle = d.failed ? C.loss : d.open > 0 ? C.brassBright : C.brass;
    this.roundRect(-3, -22, 6, 26, 3); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#0d0d11';
    ctx.beginPath(); ctx.arc(lvX, lvY, 3, 0, Math.PI * 2); ctx.fill();

    // fuse box above the arch
    const k = d.fuses.length;
    const boxW = k * 18 + 14;
    const boxY = top - 34;
    ctx.fillStyle = C.steel;
    this.roundRect(dx - boxW / 2, boxY, boxW, 24, 5); ctx.fill();
    ctx.strokeStyle = '#08080b'; ctx.lineWidth = 1.5;
    this.roundRect(dx - boxW / 2 + 0.75, boxY + 0.75, boxW - 1.5, 22.5, 5); ctx.stroke();
    ctx.fillStyle = accent;
    ctx.fillRect(dx - 3, top - 10, 6, 10);
    for (let f = 0; f < k; f++) {
      const fx = dx - ((k - 1) * 18) / 2 + f * 18;
      const fy = boxY + 12;
      const s = d.fuses[f];
      ctx.fillStyle = s === 'live' ? C.fuseLive : s === 'dead' ? C.fuseDead : C.fuseIdle;
      if (s === 'live') { ctx.shadowColor = C.fuseLive; ctx.shadowBlur = 12; }
      this.roundRect(fx - 6, fy - 5, 12, 10, 3); ctx.fill();
      ctx.shadowBlur = 0;
      if (s === 'dead') { ctx.strokeStyle = '#6a2a2a'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(fx - 4, fy - 3); ctx.lineTo(fx + 4, fy + 3); ctx.moveTo(fx + 4, fy - 3); ctx.lineTo(fx - 4, fy + 3); ctx.stroke(); }
      if (s === 'idle' && !this.anim) { ctx.fillStyle = `rgba(255,224,104,${0.25 + ((Math.sin(now / 700 + i + f) + 1) / 2) * 0.35})`; this.roundRect(fx - 6, fy - 5, 12, 10, 3); ctx.fill(); }
    }

    // multiplier chip, gate name above it
    const label = this.labels[i];
    if (label) {
      ctx.font = '700 15px "Chakra Petch", "Rubik", sans-serif';
      const w = ctx.measureText(label).width + 20;
      const cy = boxY - 30;
      ctx.fillStyle = 'rgba(8,8,11,0.92)';
      this.roundRect(dx - w / 2, cy - 14, w, 28, 7); ctx.fill();
      ctx.strokeStyle = d.failed ? C.loss : d.cleared ? C.brass : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      this.roundRect(dx - w / 2 + 0.5, cy - 13.5, w - 1, 27, 7); ctx.stroke();
      ctx.fillStyle = d.failed ? C.loss : d.cleared ? C.brassBright : 'rgba(255,255,255,0.82)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, dx, cy + 1);
      ctx.font = '600 9px "Rubik", sans-serif';
      ctx.fillStyle = C.textDim;
      ctx.fillText(`GATE ${i + 1}`, dx, cy - 23);
    }

    ctx.restore();
  }

  private drawVolt(p: Pose, now: number): void {
    const { ctx } = this;
    const cx = p.x;
    const cy = GROUND_Y - VOLT_R - p.y;

    if (p.mood === 'dazed' && p.tilt < -2) {
      // Three small stars circling above him, the cartoon way.
      ctx.font = '700 11px "Chakra Petch", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < 3; i++) {
        const a = now / 380 + (i * Math.PI * 2) / 3;
        const sx = cx + Math.cos(a) * 24;
        const sy = GROUND_Y - VOLT_R * 2 - 14 + Math.sin(a) * 6;
        ctx.globalAlpha = 0.55 + Math.sin(a) * 0.35;
        ctx.fillStyle = C.brassBright;
        ctx.fillText('★', sx, sy);
      }
      ctx.globalAlpha = 1;
    }
    const blink = now > this.blinkAt && now < this.blinkAt + 110;
    if (now > this.blinkAt + 110) this.blinkAt = now + 2400 + Math.random() * 2200;

    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.ellipse(cx, GROUND_Y - 2, VOLT_R * 0.95 * p.sx, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(p.tilt);
    ctx.scale(p.sx, p.sy);

    const stride = p.mood === 'run' ? Math.sin(p.legs * Math.PI) * 10 : 0;
    ctx.fillStyle = C.ink;
    ctx.beginPath(); ctx.ellipse(-11 + stride, VOLT_R - 2 - p.footTap * 7, 9, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(11 - stride, VOLT_R - 2, 9, 5, 0, 0, Math.PI * 2); ctx.fill();

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

    const flick = p.mood === 'charge' || p.mood === 'run' ? 1 + Math.random() * 0.5 : 1 + (Math.random() < 0.02 ? 0.4 : 0);
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

    const ex = 10;
    const ey = -6;
    const lookX = p.mood === 'idle' ? (p.look - 0.5) * 6 : 2.5;
    const lookY = p.mood === 'charge' ? 1 : 0;
    for (const side of [-1, 1]) {
      const x = side * ex;
      if (p.mood === 'dazed') {
        ctx.strokeStyle = C.ink; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x - 5, ey - 5); ctx.lineTo(x + 5, ey + 5); ctx.moveTo(x + 5, ey - 5); ctx.lineTo(x - 5, ey + 5); ctx.stroke();
        continue;
      }
      const squint = blink || p.mood === 'happy' || p.mood === 'bow';
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      if (squint) ctx.ellipse(x, ey, 7.5, p.mood === 'happy' || p.mood === 'bow' ? 3 : 1.2, 0, 0, Math.PI * 2);
      else if (p.mood === 'charge' || p.mood === 'brace') ctx.ellipse(x, ey, 7.5, 5, 0, 0, Math.PI * 2);
      else ctx.ellipse(x, ey, 7.5, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      if (!squint) {
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
