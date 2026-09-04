import {
  MAX_LANES,
  WAD,
  formatMultiplier,
  maxMultiplierWad,
  paytable,
  resolveTrace,
  type Build,
} from './lib/apparatus';
import { PRESETS, addGate, addWire, asBuild, createEditor, isRunnable, pool, removeWire } from './game/build';
import { Sound } from './game/sound';
import { Stage, type StageEvent } from './game/stage';
import { createDemoHost } from './host/demo';
import { connectLiveHost } from './host/live';
import type { GameHost, HostView, RoundView } from './host/types';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const editor = createEditor();
const sound = new Sound();

let host: GameHost;
let view: HostView;
let running = false;
let auto = false;
let clearedNotes = 0;

const canvas = el<HTMLCanvasElement>('stage');
const stage = new Stage(canvas, onStageEvent);

function onStageEvent(event: StageEvent): void {
  switch (event.type) {
    case 'charge':
      clearedNotes = 0;
      sound.charge();
      break;
    case 'lane':
      if (event.live) sound.laneLive();
      else sound.laneDead();
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

function formatUnits(value: bigint, decimals: number, places = 2): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = ((value % base) * 10n ** BigInt(places)) / base;
  return `${whole.toLocaleString('en-US')}.${frac.toString().padStart(places, '0')}`;
}

function parseUnits(text: string, decimals: number): bigint {
  const cleaned = text.replace(/[^0-9.]/g, '');
  const [whole = '0', frac = ''] = cleaned.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

function currentWager(): bigint {
  return parseUnits(el<HTMLInputElement>('wager').value || '0', view.decimals);
}

function setWager(value: bigint): void {
  el<HTMLInputElement>('wager').value = formatUnits(value < 0n ? 0n : value, view.decimals);
}

/** The largest bet the platform will accept for this build right now. */
function wagerCeiling(build: Build): bigint {
  const limit = view.maxWagerFor(build);
  const balance = view.balance;
  if (limit === null) return balance;
  return limit < balance ? limit : balance;
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
    up.disabled = running || pool(editor) <= 0 || lanes >= MAX_LANES;
    up.addEventListener('click', () => {
      if (addWire(editor, index)) render();
    });

    const count = document.createElement('span');
    count.className = 'gate-count';
    count.textContent = String(lanes);

    const down = document.createElement('button');
    down.type = 'button';
    down.textContent = '−';
    down.disabled = running;
    down.addEventListener('click', () => {
      if (removeWire(editor, index)) render();
    });

    cell.append(up, count, down);
    bar.append(cell);
  });

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'add-gate';
  add.textContent = '+ GATE';
  add.disabled = running || pool(editor) <= 0 || editor.gates.length >= 12;
  add.addEventListener('click', () => {
    if (addGate(editor)) render();
  });
  bar.append(add);
}

function renderPresets(): void {
  const wrap = el('presets');
  if (wrap.childElementCount) return;

  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset';
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

function renderPaytable(): void {
  const wrap = el('paytable');
  wrap.innerHTML = '';

  if (!isRunnable(editor)) {
    wrap.innerHTML = `<div class="paytable-empty">Spend all twelve wires to arm the apparatus.</div>`;
    return;
  }

  const build = asBuild(editor);
  for (const row of paytable(build)) {
    const chance = (Number(row.exactNum) / 4096) * 100;
    const cell = document.createElement('div');
    cell.className = 'pay-cell';
    if (row.multWad > WAD) cell.classList.add('pay-win');
    cell.innerHTML = `<b>${formatMultiplier(row.multWad)}</b><span>${row.depth} gate${row.depth > 1 ? 's' : ''}</span><i>${chance.toFixed(chance < 1 ? 2 : 1)}%</i>`;
    wrap.append(cell);
  }
}

function render(): void {
  stage.setBuild(editor.gates);
  renderGateBar();
  renderPresets();
  renderPaytable();

  const runnable = isRunnable(editor);
  el('pool').textContent = String(pool(editor));
  el('top').textContent = runnable ? formatMultiplier(maxMultiplierWad(asBuild(editor))) : '—';
  el('hit').textContent = runnable
    ? `${((Number(paytable(asBuild(editor))[0].reachNum) / 4096) * 100).toFixed(1)}%`
    : '—';

  el('balance').textContent = view.resolved ? formatUnits(view.balance, view.decimals) : '—';
  el('symbol').textContent = view.symbol;
  el('demoBadge').hidden = !view.demo;

  const run = el<HTMLButtonElement>('run');
  run.disabled = running || !runnable || !view.ready;
  run.textContent = running ? '···' : 'RUN';

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
    const stop = host.subscribe((next) => {
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
  const trace: boolean[][] = [];
  for (let i = 0; i <= Math.min(depth, build.length - 1); i++) {
    const lanes = Array<boolean>(build[i]).fill(false);
    if (i < depth) lanes[Math.floor(Math.random() * lanes.length)] = true;
    trace.push(lanes);
  }
  return depth >= build.length ? build.map((k) => Array<boolean>(k).fill(true)) : trace;
}

async function runRound(): Promise<void> {
  if (running || !host || !isRunnable(editor) || !view.ready) return;

  const build = asBuild(editor);
  const wager = currentWager();
  if (wager <= 0n) return;

  const ceiling = wagerCeiling(build);
  if (wager > ceiling) {
    verdict('Bet above the house limit for this build', 'loss');
    setWager(ceiling);
    return;
  }

  running = true;
  verdict('', 'idle');
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
    if (payout > wager) {
      verdict(`+${formatUnits(payout - wager, view.decimals)} · ${formatMultiplier((payout * WAD) / wager)}`, 'win');
    } else if (payout > 0n) {
      verdict(`${formatMultiplier((payout * WAD) / wager)} · ${depth} of ${build.length}`, 'loss');
    } else {
      verdict('Gate 1 held. Nothing got through.', 'loss');
    }
  } catch (error) {
    verdict(error instanceof Error ? error.message : 'Round failed', 'loss');
    auto = false;
    el('auto').setAttribute('aria-pressed', 'false');
  } finally {
    running = false;
    render();
  }

  if (auto) {
    setTimeout(() => {
      if (auto && !running) void runRound();
    }, 700);
  }
}

function wireControls(): void {
  el('run').addEventListener('click', () => {
    sound.unlock();
    stage.clearRound();
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
    el('mute').setAttribute('aria-pressed', String(sound.muted));
    el('mute').textContent = sound.muted ? '♪̸' : '♪';
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-bet]')) {
    button.addEventListener('click', () => {
      const mode = button.dataset.bet;
      const current = currentWager();
      if (mode === 'half') setWager(current / 2n);
      if (mode === 'double') setWager(current * 2n);
      if (mode === 'max') setWager(wagerCeiling(asBuild(editor)));
    });
  }

  canvas.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect();
    stage.setHover(running ? -1 : stage.gateAt(event.clientX - rect.left));
  });
  canvas.addEventListener('mouseleave', () => stage.setHover(-1));
  canvas.addEventListener('click', (event) => {
    if (running) return;
    const rect = canvas.getBoundingClientRect();
    const index = stage.gateAt(event.clientX - rect.left);
    sound.unlock();
    if (index >= 0 && (event.shiftKey ? removeWire(editor, index) : addWire(editor, index))) render();
  });

  document.addEventListener('keydown', (event) => {
    if (event.code === 'Space' && !running) {
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

  void connectLiveHost().then((live) => {
    host = live ?? createDemoHost();
    host.subscribe((next) => {
      view = next;
      if (!running) render();
    });
  });
}

boot();
