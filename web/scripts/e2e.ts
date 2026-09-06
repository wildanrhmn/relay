/**
 * End-to-end round test against the running local simulator stack.
 *
 * Drives real sessions through LocalCasinoHost with the real ECVRF node, then
 * checks the settled on-chain payout against the TypeScript paytable for the
 * exact randomness the node produced. Requires `npm start` inside sdk/.
 *
 *   npx vite-node scripts/e2e.ts [roundsPerBuild]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { WAD, multiplierWad, resolveDepth, type Build } from '../src/lib/relay';

const REPO = path.resolve(import.meta.dirname, '../..');
const deployment = JSON.parse(
  fs.readFileSync(path.join(REPO, 'sdk/simulator/local-node/deployed.json'), 'utf8'),
) as {
  chainId: number;
  rpcUrl: string;
  host: Address;
  vault: Address;
  token: Address;
  games: { name: string; address: Address }[];
};

const game = deployment.games.find((g) => g.name === 'RelayGame');
if (!game) throw new Error('RelayGame is not deployed — run scripts/sync-contract.sh and restart the stack');

const chain = defineChain({
  id: deployment.chainId,
  name: 'local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [deployment.rpcUrl] } },
});

const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const publicClient = createPublicClient({ chain, transport: http(deployment.rpcUrl) });
const wallet = createWalletClient({ account, chain, transport: http(deployment.rpcUrl) });

const hostAbi = parseAbi([
  'function openSession(address game, address vault, uint256 wager, bytes gameData, bytes randomnessRequestData) returns (uint256 sessionId, bytes32 requestId)',
  'event CasinoSessionOpened(uint256 indexed sessionId, address indexed game, address indexed player, address vault, address token, uint8 tokenDecimals, uint256 wager, uint256 maxEscrowStake, uint256 maxReservedProfit, string gameName, bytes gameData)',
  'event CasinoSessionSettled(uint256 indexed sessionId, address indexed game, address indexed player, uint8 phase, uint256 payout, string gameName, bytes gameState)',
  'event CasinoSessionRandomnessFulfilled(uint256 indexed sessionId, address indexed provider, bytes32 indexed requestId, uint64 requestNonce, bytes32 randomness)',
]);
const erc20Abi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

const encodeBuild = (build: Build) => encodeAbiParameters([{ type: 'uint8[]' }], [build as readonly number[]]);

const BUILDS: { name: string; build: Build }[] = [
  { name: 'GRIND', build: [4, 4, 4] },
  { name: 'CLIMB', build: [4, 4, 1, 1, 1, 1] },
  { name: 'MOONSHOT', build: Array<number>(12).fill(1) },
];

async function waitForSettlement(sessionId: bigint, fromBlock: bigint) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const logs = await publicClient.getLogs({ address: deployment.host, fromBlock, toBlock: 'latest' });
    let randomness: bigint | undefined;
    let payout: bigint | undefined;
    let gameState: Hex | undefined;

    for (const log of logs) {
      try {
        const parsed = decodeEventLog({ abi: hostAbi, data: log.data, topics: log.topics });
        const args = parsed.args as Record<string, unknown>;
        if (args.sessionId !== sessionId) continue;
        if (parsed.eventName === 'CasinoSessionRandomnessFulfilled') randomness = BigInt(args.randomness as Hex);
        if (parsed.eventName === 'CasinoSessionSettled') {
          payout = args.payout as bigint;
          gameState = args.gameState as Hex;
        }
      } catch {
        /* unrelated event */
      }
    }

    if (payout !== undefined && randomness !== undefined) return { payout, randomness, gameState };
    if (Date.now() > deadline) throw new Error(`session ${sessionId} never settled`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  const rounds = Number(process.argv[2] ?? 12);
  const wager = WAD;

  await wallet.writeContract({
    address: deployment.token,
    abi: erc20Abi,
    functionName: 'approve',
    args: [deployment.host, 2n ** 255n],
  });

  let failures = 0;

  for (const { name, build } of BUILDS) {
    let staked = 0n;
    let returned = 0n;
    const depths: number[] = [];

    for (let i = 0; i < rounds; i++) {
      const fromBlock = await publicClient.getBlockNumber();
      const hash = await wallet.writeContract({
        address: deployment.host,
        abi: hostAbi,
        functionName: 'openSession',
        args: [game.address, deployment.vault, wager, encodeBuild(build), '0x'],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      let sessionId: bigint | undefined;
      for (const log of receipt.logs) {
        try {
          const parsed = decodeEventLog({ abi: hostAbi, data: log.data, topics: log.topics });
          const args = parsed.args as Record<string, unknown>;
          if (args.sessionId !== undefined) sessionId = args.sessionId as bigint;
        } catch {
          /* unrelated event */
        }
      }
      if (sessionId === undefined) throw new Error('no sessionId in openSession receipt');

      const settled = await waitForSettlement(sessionId, fromBlock);
      const expectedDepth = resolveDepth(build, settled.randomness);
      const expectedPayout = (wager * multiplierWad(build, expectedDepth)) / WAD;

      if (settled.payout !== expectedPayout) {
        failures++;
        console.error(
          `MISMATCH ${name} session ${sessionId}: chain=${settled.payout} expected=${expectedPayout} depth=${expectedDepth}`,
        );
      }

      depths.push(expectedDepth);
      staked += wager;
      returned += settled.payout;
    }

    const rtp = (Number(returned) / Number(staked)) * 100;
    console.log(
      `${name.padEnd(9)} rounds=${rounds}  returned=${rtp.toFixed(1)}%  depths=[${depths.join(',')}]  max=${Math.max(...depths)}/${build.length}`,
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} payout mismatches`);
    process.exit(1);
  }
  console.log('\nAll on-chain payouts matched the TypeScript paytable.');
}

void main();
