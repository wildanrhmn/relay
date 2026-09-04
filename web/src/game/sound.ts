/**
 * Synthesised audio — no asset loading, so the page stays instant.
 *
 * Every gate the current clears plays the next note of a rising pentatonic run,
 * so the payout is audible as it happens: a deep run climbs, a failure cuts the
 * phrase off mid-note.
 */
const PENTATONIC = [0, 2, 4, 7, 9];
const BASE_HZ = 196;

const noteHz = (step: number) =>
  BASE_HZ * 2 ** ((PENTATONIC[step % PENTATONIC.length] + 12 * Math.floor(step / PENTATONIC.length)) / 12);

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.28;
    this.master.connect(this.ctx.destination);

    const frames = Math.floor(this.ctx.sampleRate * 0.25);
    this.noise = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const channel = this.noise.getChannelData(0);
    for (let i = 0; i < frames; i++) channel[i] = Math.random() * 2 - 1;
  }

  private get live(): { ctx: AudioContext; master: GainNode } | null {
    if (this.muted || !this.ctx || !this.master || this.ctx.state !== 'running') return null;
    return { ctx: this.ctx, master: this.master };
  }

  private tone(hz: number, duration: number, type: OscillatorType, gain: number, detune = 0): void {
    const live = this.live;
    if (!live) return;
    const { ctx, master } = live;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = hz;
    osc.detune.value = detune;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(gain, now + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(env).connect(master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  private burst(duration: number, gain: number, hz: number): void {
    const live = this.live;
    if (!live || !this.noise) return;
    const { ctx, master } = live;
    const now = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = hz;
    filter.Q.value = 1.4;

    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    src.connect(filter).connect(env).connect(master);
    src.start(now);
    src.stop(now + duration);
  }

  charge(): void {
    this.tone(110, 0.18, 'sawtooth', 0.10);
    this.burst(0.12, 0.05, 900);
  }

  laneLive(): void {
    this.burst(0.05, 0.09, 2400);
  }

  laneDead(): void {
    this.burst(0.06, 0.05, 420);
  }

  gateCleared(step: number): void {
    this.tone(noteHz(step), 0.34, 'triangle', 0.22);
    this.tone(noteHz(step) * 2, 0.16, 'sine', 0.07, 4);
  }

  failed(): void {
    this.tone(96, 0.34, 'sawtooth', 0.13);
    this.burst(0.22, 0.09, 260);
  }

  won(gatesCleared: number): void {
    const live = this.live;
    if (!live) return;
    [0, 4, 7, 12].forEach((semitone, i) => {
      setTimeout(() => this.tone(noteHz(gatesCleared) * 2 ** (semitone / 12), 0.5, 'triangle', 0.16), i * 55);
    });
  }
}
