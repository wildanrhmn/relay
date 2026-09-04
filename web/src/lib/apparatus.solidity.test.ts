/**
 * Differential test: the deployed contract must agree with the TypeScript
 * paytable exactly. If these ever diverge, the RTP shown to the player and the
 * RTP declared on the submission form stop being the same number.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  type Abi,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  WAD,
  enumerateBuilds,
  maxMultiplierWad,
  multiplierWad,
  resolveDepth,
  topProbabilityWad,
  type Build,
} from './apparatus';

const REPO = path.resolve(import.meta.dirname, '../../..');
const PORT = 8546;
const RPC = `http://127.0.0.1:${PORT}`;
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;

const chain = defineChain({
  id: 31337,
  name: 'diff-test',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

async function compile() {
  const solc = (await import(pathToFileURL(path.join(REPO, 'sdk/node_modules/solc/index.js')).href)).default;
  const target = 'contracts/Apparatus.sol';
  const findImports = (p: string) => {
    for (const candidate of [path.resolve(REPO, p), path.resolve(REPO, 'contracts', p)]) {
      if (fs.existsSync(candidate)) return { contents: fs.readFileSync(candidate, 'utf8') };
    }
    return { error: `not found: ${p}` };
  };
  const input = {
    language: 'Solidity',
    sources: { [target]: { content: fs.readFileSync(path.join(REPO, target), 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const fatal = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (fatal.length) throw new Error(fatal.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
  const artifact = out.contracts[target].ApparatusGame;
  return { abi: artifact.abi as Abi, bytecode: `0x${artifact.evm.bytecode.object}` as const };
}

function hardhatCli() {
  const pkg = path.join(REPO, 'sdk/node_modules/hardhat/package.json');
  const bin = JSON.parse(fs.readFileSync(pkg, 'utf8')).bin;
  return path.join(path.dirname(pkg), typeof bin === 'string' ? bin : bin.hardhat);
}

const encodeBuild = (lanes: Build) => encodeAbiParameters([{ type: 'uint8[]' }], [lanes as readonly number[]]);

let node: ChildProcess;
let address: Address;
let abi: Abi;
const publicClient = createPublicClient({ chain, transport: http(RPC) });

describe('solidity matches typescript', () => {
  beforeAll(async () => {
    node = spawn(process.execPath, [hardhatCli(), 'node', '--hostname', '127.0.0.1', '--port', String(PORT)], {
      cwd: path.join(REPO, 'sdk/simulator'),
      stdio: 'ignore',
    });

    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        await publicClient.getBlockNumber();
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('hardhat node never became ready');
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    const compiled = await compile();
    abi = compiled.abi;
    const wallet = createWalletClient({ account: privateKeyToAccount(DEV_KEY), chain, transport: http(RPC) });
    const hash = await wallet.deployContract({ abi, bytecode: compiled.bytecode });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    address = receipt.contractAddress!;
  }, 120_000);

  afterAll(() => node?.kill());

  it('agrees on the multiplier for every depth of a sampled build set', async () => {
    const all = enumerateBuilds();
    const sample = [
      [4, 4, 4],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [3, 2, 2, 2, 1, 1, 1],
      ...Array.from({ length: 25 }, (_, i) => all[Math.floor((i * all.length) / 25)]),
    ];

    for (const build of sample) {
      for (let depth = 0; depth <= build.length; depth++) {
        const onChain = (await publicClient.readContract({
          address,
          abi,
          functionName: 'previewMultiplierWad',
          args: [encodeBuild(build), BigInt(depth)],
        })) as bigint;
        expect(onChain, `build ${JSON.stringify(build)} depth ${depth}`).toBe(multiplierWad(build, depth));
      }
    }
  }, 120_000);

  it('agrees on quoteRiskParams', async () => {
    const wager = 1_000_000_000_000_000_000n;
    for (const build of [[4, 4, 4], [2, 2, 2, 2, 2, 2], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]]) {
      const [maxPayout, probabilityWad, expectedPayout] = (await publicClient.readContract({
        address,
        abi,
        functionName: 'quoteRiskParams',
        args: [wager, encodeBuild(build)],
      })) as [bigint, bigint, bigint, bigint];

      expect(maxPayout).toBe((wager * maxMultiplierWad(build)) / WAD);
      expect(probabilityWad).toBe(topProbabilityWad(build));
      expect(expectedPayout).toBe((wager * 960_000_000_000_000_000n) / WAD);
    }
  }, 120_000);

  it('agrees on the settled payout for random VRF words', async () => {
    const wager = 1_000_000_000_000_000_000n;
    const builds = [
      [4, 4, 4],
      [3, 3, 3, 3],
      [2, 2, 2, 2, 2, 2],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    ];

    for (const build of builds) {
      for (let i = 0; i < 12; i++) {
        const randomness = BigInt(`0x${((i * 0x9e3779b9) >>> 0).toString(16).padStart(8, '0').repeat(8)}`);
        const ctx = {
          sessionId: 1n,
          player: '0x0000000000000000000000000000000000000001' as Address,
          vault: '0x0000000000000000000000000000000000000002' as Address,
          wagerBase: wager,
          escrowedStake: wager,
          reservedProfit: 0n,
          step: 1,
          gameData: encodeBuild(build),
          gameState: '0x' as const,
        };

        const step = (await publicClient.readContract({
          address,
          abi,
          functionName: 'onRandomness',
          args: [ctx, `0x${randomness.toString(16).padStart(64, '0')}`],
        })) as { payout: bigint };

        const depth = resolveDepth(build, randomness);
        expect(step.payout, `build ${JSON.stringify(build)} seed ${i}`).toBe(
          (wager * multiplierWad(build, depth)) / WAD,
        );
      }
    }
  }, 180_000);

  it('rejects builds that do not spend the budget', async () => {
    await expect(
      publicClient.readContract({
        address,
        abi,
        functionName: 'previewMultiplierWad',
        args: [encodeBuild([4, 4, 3]), 1n],
      }),
    ).rejects.toThrow();
  }, 60_000);
});
