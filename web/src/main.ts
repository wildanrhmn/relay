import {
  MAX_LANES,
  MAX_TIERS,
  WAD,
  formatMultiplier,
  maxMultiplierWad,
  paytable,
  resolveTrace,
  type Build,
} from './lib/apparatus';
import { PRESETS, addGate, addWire, asBuild, createEditor, isRunnable, pool, removeWire } from './game/build';
import { Sound } from './game/sound';
import type { StageEvent, StageLike } from './game/stage-api';
import { createDemoHost } from './host/demo';
import { connectLiveHost } from './host/live';
import type { GameHost, HostView, RoundView } from './host/types';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const IDLE_CAPTION = 'Build your machine, then send the current through it.';

const editor = createEditor();
const sound = new Sound();

let host: GameHost | undefined;
let stage: StageLike | undefined;
let view: HostView;
let running = false;
let auto = false;
let clearedNotes = 0;
let lastDepth = -1;
const history: { multWad: bigint; win: boolean }[] = [];

const canvas = el<HTMLCanvasElement>('stage');

function onStageEvent(event: StageEvent): void {
  switch (event.type) {
    case 'charge':
      clearedNotes = 0;
      sound.charge();
      break;
    case 'lane':
      event.live ? sound.laneLive() : sound.laneDead();
      break;
    case 'gate':
      sound.gateCleared(clearedNotes++);
      break;
    case 'failed':
      sound.failed();
      break;
    case 'won':
      sound.won(event.gates);
      break;
  }
}

/** WebGL corridor when the device can render it, flat canvas stage otherwise. */
async function createStage(): Promise<StageLike> {
  const probe = document.createElement('canvas');
  const hasWebGL = Boolean(probe.getContext('webgl2') ?? probe.getContext('webgl'));

  if (hasWebGL) {
    try {
      const { Scene3D } = await import('./game/scene3d');
      return new Scene3D(canvas, onStageEvent, el('labels'));
    } catch (error) {
      console.warn('[apparatus] 3D stage unavailable, using 2D fallback', error);
    }
  }
  const { Stage } = await import('./game/stage');
  return new Stage(canvas, onStageEvent);
}

function formatUnits(value: bigint, decimals: number, places = 2): string {
  const base = 10n ** BigInt(decimals);
  const frac = ((value % base) * 10n ** BigInt(places)) / base;
  return `${(value / base).toLocaleString('en-US')}.${frac.toString().padStart(places, '0')}`;
}

function parseUnits(text: string, decimals: number): bigint {
  const [whole = '0', frac = ''] = text.replace(/[^0-9.]/g, '').split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

const currentWager = () => parseUnits(el<HTMLInputElement>('wager').value || '0', view.decimals);

function setWager(value: bigint): void {
  el<HTMLInputElement>('wager').value = formatUnits(value < 0n ? 0n : value, view.decimals);
}

/** The largest bet the platform will accept for this build right now. */
function wagerCeiling(build: Build): bigint {
  const limit = view.maxWagerFor(build);
  if (limit === null) return view.balance;
  return limit < view.balance ? limit : view.balance;
}

function renderGateBar(): void {
  const bar = el('gateBar');
  bar.innerHTML = '';

  editor.gates.forEach((lanes, index) => {
    const cell = document.createElement('div');
    cell.className = 'gate-cell';

    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = '+';
    up.title = `Add a wire to gate ${index + 1}`;
    up.disabled = running || pool(editor) <= 0 || lanes >= MAX_LANES;
    up.addEventListener('click', () => addWire(editor, index) && render());

    const count = document.createElement('span');
    count.className = 'gate-count';
    count.textContent = String(lanes);

    const down = document.createElement('button');
    down.type = 'button';
    down.textContent = '−';
    down.title = `Remove a wire from gate ${index + 1}`;
    down.disabled = running;
    down.addEventListener('click', () => removeWire(editor, index) && render());

    cell.append(up, count, down);
    bar.append(cell);
  });

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'add-gate';
  add.textContent = '+ GATE';
  add.disabled = running || pool(editor) <= 0 || editor.gates.length >= MAX_TIERS;
  add.addEventListener('click', () => addGate(editor) && render());
  bar.append(add);
}

function renderPresets(): void {
  const wrap = el('presets');
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((k, i) => k === b[i]);

  if (!wrap.childElementCount) {
    for (const preset of PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset';
      button.dataset.preset = preset.name;
      button.innerHTML = `<b>${preset.name}</b><span>${preset.blurb}</span>`;
      button.addEventListener('click', () => {
        if (running) return;
        editor.gates = [...preset.gates];
        sound.unlock();
        render();
      });
      wrap.append(button);
    }
  }

  for (const button of wrap.querySelectorAll<HTMLButtonElement>('.preset')) {
    const preset = PRESETS.find((p) => p.name === button.dataset.preset);
    button.setAttribute('aria-pressed', String(Boolean(preset && same(preset.gates, editor.gates))));
  }
}

function renderPaytable(): void {
  const wrap = el('paytable');
  wrap.innerHTML = '';

  if (!isRunnable(editor)) {
    wrap.innerHTML = '<div class="paytable-empty">Spend all twelve wires to arm the apparatus.</div>';
    return;
  }

  for (const row of paytable(asBuild(editor))) {
    const chance = (Number(row.exactNum) / 4096) * 100;
    const cell = document.createElement('div');
    cell.className = 'pay-cell';
    if (row.multWad > WAD) cell.classList.add('pay-win');
    if (row.depth === lastDepth) cell.classList.add('pay-reached');
    cell.innerHTML =
      `<b>${formatMultiplier(row.multWad)}</b>` +
      `<span>${row.depth} gate${row.depth > 1 ? 's' : ''}</span>` +
      `<i>${chance.toFixed(chance < 1 ? 2 : 1)}%</i>`;
    wrap.append(cell);
  }
}

function renderHistory(): void {
  const wrap = el('history');
  wrap.innerHTML = '';
  for (const entry of history.slice(-7)) {
    const chip = document.createElement('div');
    chip.className = `hist-chip${entry.win ? ' hist-win' : ''}`;
    chip.textContent = formatMultiplier(entry.multWad);
    wrap.append(chip);
  }
}

function setCaption(text: string, live = false): void {
  const node = el('caption');
  node.textContent = text;
  node.classList.toggle('is-live', live);
}

function render(): void {
  stage?.setBuild(editor.gates);
  if (isRunnable(editor)) {
    stage?.setLabels?.(paytable(asBuild(editor)).map((row) => formatMultiplier(row.multWad)));
  }
  renderGateBar();
  renderPresets();
  renderPaytable();
  renderHistory();

  const runnable = isRunnable(editor);
  const left = pool(editor);
  el('pool').textContent = `${left} left`;
  el('top').textContent = runnable ? formatMultiplier(maxMultiplierWad(asBuild(editor))) : '—';
  el('hit').textContent = runnable
    ? `${((Number(paytable(asBuild(editor))[0].reachNum) / 4096) * 100).toFixed(1)}%`
    : '—';

  el('balance').textContent = view.resolved ? formatUnits(view.balance, view.decimals) : '—';
  el('symbol').textContent = view.symbol;
  el('demoBadge').hidden = !view.demo;

  const run = el<HTMLButtonElement>('run');
  run.disabled = running || !runnable || !view.ready;
  run.textContent = running ? '· · ·' : 'RUN';

  const notice = el('notice');
  const needsWallet = view.resolved && !view.demo && !view.ready;
  notice.hidden = !needsWallet;
  if (needsWallet) notice.textContent = 'Connect your wallet in Chain to place a bet.';
}

function verdict(text: string, tone: 'win' | 'loss' | 'idle'): void {
  const node = el('verdict');
  node.textContent = text;
  node.className = `verdict verdict-${tone}${text ? ' verdict-show' : ''}`;
}

function waitForSettled(key: string): Promise<RoundView> {
  const existing = view.rounds.find((round) => round.key === key && round.settled);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const stop = host!.subscribe((next) => {
      const round = next.rounds.find((item) => item.key === key && item.settled);
      if (round) {
        stop();
        resolve(round);
      }
    });
  });
}

/** Fallback trace when the host does not expose the raw VRF word. */
function syntheticTrace(build: Build, depth: number): boolean[][] {
  if (depth >= build.length) return build.map((k) => Array<boolean>(k).fill(true));
  const trace: boolean[][] = [];
  for (let i = 0; i <= Math.min(depth, build.length - 1); i++) {
    const lanes = Array<boolean>(build[i]).fill(false);
    if (i < depth) lanes[Math.floor(Math.random() * lanes.length)] = true;
    trace.push(lanes);
  }
  return trace;
}

/** Chain errors arrive as multi-line dumps with raw calldata; keep the banner human. */
function shortError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'Round failed';
  const cleaned = firstLine.replace(/0x[0-9a-fA-F]{16,}/g, '0x…');
  return cleaned.length > 92 ? `${cleaned.slice(0, 92)}…` : cleaned;
}

async function runRound(): Promise<void> {
  if (running || !host || !stage || !isRunnable(editor) || !view.ready) return;

  const build = asBuild(editor);
  const wager = currentWager();
  if (wager <= 0n) return;

  const ceiling = wagerCeiling(build);
  if (wager > ceiling) {
    verdict('Bet is above the house limit for this build', 'loss');
    setWager(ceiling);
    return;
  }

  running = true;
  lastDepth = -1;
  verdict('', 'idle');
  setCaption('Current running — it stops at the first gate that holds.', true);
  render();

  try {
    const key = await host.openRound(wager, build);
    const round = await waitForSettled(key);
    const depth = round.depth ?? 0;
    const trace =
      round.randomness !== undefined ? resolveTrace(build, round.randomness) : syntheticTrace(build, depth);

    await stage.play(trace);
    await host.reveal(key);

    const payout = round.payout ?? 0n;
    const multWad = (payout * WAD) / wager;
    lastDepth = depth;
    history.push({ multWad, win: payout > wager });

    if (payout > wager) {
      verdict(`+${formatUnits(payout - wager, view.decimals)}  ·  ${formatMultiplier(multWad)}`, 'win');
    } else if (payout > 0n) {
      verdict(`${formatMultiplier(multWad)}  ·  ${depth} of ${build.length} gates`, 'loss');
    } else {
      verdict('Gate 1 held. Nothing got through.', 'loss');
    }
  } catch (error) {
    console.error('[apparatus] round failed', error);
    verdict(shortError(error), 'loss');
    auto = false;
    el('auto').setAttribute('aria-pressed', 'false');
  } finally {
    running = false;
    setCaption(IDLE_CAPTION);
    render();
  }

  if (auto) setTimeout(() => auto && !running && void runRound(), 750);
}

function wireControls(): void {
  el('run').addEventListener('click', () => {
    sound.unlock();
    stage?.clearRound();
    void runRound();
  });

  el('auto').addEventListener('click', () => {
    auto = !auto;
    el('auto').setAttribute('aria-pressed', String(auto));
    sound.unlock();
    if (auto && !running) void runRound();
  });

  el('mute').addEventListener('click', () => {
    sound.muted = !sound.muted;
    el('mute').setAttribute('aria-pressed', String(!sound.muted));
    el('mute').textContent = sound.muted ? 'MUTED' : 'SOUND';
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-bet]')) {
    button.addEventListener('click', () => {
      const current = currentWager();
      const mode = button.dataset.bet;
      if (mode === 'quarter') setWager(current / 4n);
      if (mode === 'half') setWager(current / 2n);
      if (mode === 'double') setWager(current * 2n);
      if (mode === 'max') setWager(wagerCeiling(asBuild(editor)));
    });
  }

  const localPoint = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  canvas.addEventListener('mousemove', (event) => {
    const { x, y } = localPoint(event);
    stage?.setHover(running ? -1 : (stage?.gateAt(x, y) ?? -1));
  });
  canvas.addEventListener('mouseleave', () => stage?.setHover(-1));
  canvas.addEventListener('click', (event) => {
    if (running || !stage) return;
    const { x, y } = localPoint(event);
    const index = stage.gateAt(x, y);
    sound.unlock();
    if (index >= 0 && (event.shiftKey ? removeWire(editor, index) : addWire(editor, index))) render();
  });

  document.addEventListener('keydown', (event) => {
    if (event.code === 'Space' && !running && event.target === document.body) {
      event.preventDefault();
      sound.unlock();
      void runRound();
    }
  });
}

/** Shown for the moment it takes to find out whether a real host is listening. */
const PENDING_VIEW: HostView = {
  ready: false,
  resolved: false,
  demo: false,
  balance: 0n,
  decimals: 18,
  symbol: 'chUSD',
  rounds: [],
  maxWagerFor: () => null,
};

function boot(): void {
  // Paint the apparatus immediately: probing for the host takes up to 1.5s and
  // the standalone URL must not open on an empty frame.
  view = PENDING_VIEW;
  wireControls();
  render();

  void createStage().then((created) => {
    stage = created;
    stage.setBuild(editor.gates);
  });

  void connectLiveHost().then((live) => {
    host = live ?? createDemoHost();
    host.subscribe((next) => {
      view = next;
      // The host grows the iframe to fit content, so 100dvh is meaningless in
      // there; size to the height it actually reports instead.
      if (next.availableHeight) {
        document.documentElement.style.setProperty('--app-h', `${next.availableHeight}px`);
      }
      if (!running) render();
    });
  });
}

boot();
