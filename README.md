# Relay

A Chain Jam Vol. 1 entry. Spend twelve wires across a row of gates. A gate opens if
**any** of its wires survive. You are paid for how far the current gets.

There is no cash-out, no per-round decision and nothing to learn. You shape a machine
once, then run it — wide and shallow grinds out small wins, thin and deep almost always
dies at the first gate and occasionally pays 605×. Every one of the 1,490 legal builds
returns exactly the same 96%.

The current is a character. Relay runs the row of doors you built; each door's wires are
the fuses on its lintel, any live fuse slides the door open, and a door whose fuses all
blow stays shut — so the gate that stops the run is also the punchline. Relay is drawn
entirely in code, and the round's state machine is what a Rive or sprite version would
plug into later.

## The math

A gate holding `k` wires opens with probability exactly `(2^k − 1) / 2^k`. Wires are
independent single VRF bits, so clearing the first `d` gates has probability

```
R_d = ∏(2^k_i − 1) / 2^(Σ k_i)
```

Because the wire budget is fixed at 12, every probability in the game is a rational
number over `2^12 = 4096`. Nothing is approximated and no floating point is involved
anywhere in the paytable.

The payout for stopping at depth `d` is `mult(d) = C / R_d`, with `C` chosen per build so
the expectation is exactly the declared RTP:

```
C = RTP / (1 + Σ_{i≥2} 2^(−k_i))
```

That normalisation is what makes every build worth the same. The player is choosing the
*shape* of the distribution — hit frequency, skew, ceiling — never the edge.

| Build | Any pay | Top pay |
| --- | --- | --- |
| `[4,4,4]` — GRIND | 93.8% | 1.04× |
| `[4,4,1,1,1,1]` — CLIMB | 93.8% | 5.70× |
| `[1]×12` — MOONSHOT | 50.0% | 604.94× |

Integer division floors, so realised RTP is always at or just below the declared 96% —
never above, which would under-reserve the house.

**Declared RTP: 96.00%**

## Layout

| Path | What it is |
| --- | --- |
| `contracts/Relay.sol` | `ICasinoGameV2` implementation — the canonical copy |
| `web/src/lib/relay.ts` | The same math in TypeScript, mirrored bit-for-bit |
| `web/src/host/live.ts` | Bridge to the chain.wtf host (no wallet code) |
| `web/src/host/demo.ts` | Standalone host so the URL is playable on its own |
| `web/src/game/mascot.ts` | Relay, the current as a character: doors, fuses, the seven beats of a round |
| `web/src/game/` | Build editor, stage contract, synthesised audio |
| `web/public/game.manifest.json` | Host manifest |
| `scripts/` | SDK setup, contract sync, compile check |

## Running it

```sh
./scripts/setup-sdk.sh     # fetch the Chain casino SDK and install it
cd web && npm install

# terminal 1 — chain + VRF node + casino + harness on :3300
cd sdk && npm start

# terminal 2 — the game on :5173
cd web && npm run dev
```

Then open `http://localhost:3300/?game=http://localhost:5173`.

`http://localhost:5173` on its own boots the demo host and is fully playable, which is
what the jam gallery and judges load.

## Deploying

Either host works; both configs are committed and both keep framing open, which
matters twice — chain.wtf loads the game in an iframe, and the jam gallery renders a
live playable preview of it. Never add `X-Frame-Options` here.

**Vercel** — set the project's Root Directory to `web` in Project Settings; `web/vercel.json`
then runs relative to that (`npm ci`, `npm run build`, publishes `dist`). A `vercel.json` at the
repo root is ignored once Root Directory points elsewhere — it must live inside that directory:

```sh
npx vercel        # preview
npx vercel --prod
```

**Netlify** — `netlify.toml` sets base `web`, publish `dist`:

```sh
npx netlify deploy
npx netlify deploy --prod
```

After deploying, confirm both of these on the live URL:

```sh
curl -sI https://<your-domain>/ | grep -i x-frame-options   # must print nothing
curl -s https://<your-domain>/game.manifest.json | head -3  # must be served same-origin
```

## Tests

```sh
cd web && npm test              # unit + differential-vs-EVM
node scripts/compile-check.mjs  # compile with the simulator's exact solc settings
```

- **RTP invariant** — every one of the 1,490 legal builds is enumerated and asserted to
  return exactly 96%, never above.
- **Differential** — the contract is compiled, deployed to a real EVM, and its
  multipliers, `quoteRiskParams` and settled payouts are compared against the TypeScript
  paytable. If these ever diverge, the declared RTP stops being true.
- **Empirical** — 200k simulated rounds per preset converge on the declared RTP.

With the local stack running, `npx vite-node scripts/e2e.ts 25` drives real sessions
through `LocalCasinoHost` and the bundled ECVRF node and checks every settled on-chain
payout against the same paytable.

## Notes on the implementation

- Wires consume one VRF bit each. A single bit is exactly uniform over `{0,1}`, so no
  rejection sampling is needed here — that requirement applies when folding bytes onto a
  range that does not divide 256, which this game never does.
- `onRandomness` deliberately leaves `reservedProfitDelta` at zero. The host checks the
  payout against `escrowedStake + reservedProfit` *after* applying step deltas, so
  releasing reserved profit at settlement would cap every win at the stake.
- `quoteForfeitPayout` returns 0. This is an instant game with nothing cashable
  mid-round, and quoting anything else would be an adverse-selection exploit.
- The guest holds no wallet code and reads everything from `HostSnapshotV1`.
