// Compiles the canonical contract with the exact settings the local simulator uses,
// so a broken build fails here instead of silently not deploying in the harness.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const target = 'contracts/Apparatus.sol';

// solc lives in the vendored SDK workspace, not at the repo root.
const solc = (await import(pathToFileURL(path.join(root, 'sdk/node_modules/solc/index.js')))).default;

// solc normalises "contracts/../sdk/..." down to "sdk/...", so resolve from the
// repo root first and only then relative to the contract itself.
const findImports = (p) => {
  for (const candidate of [path.resolve(root, p), path.resolve(root, 'contracts', p)]) {
    if (fs.existsSync(candidate)) return { contents: fs.readFileSync(candidate, 'utf8') };
  }
  return { error: `not found: ${p}` };
};

const input = {
  language: 'Solidity',
  sources: { [target]: { content: fs.readFileSync(path.join(root, target), 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
for (const e of out.errors ?? []) console.log(`[${e.severity}] ${e.formattedMessage?.trim()}`);
if ((out.errors ?? []).some((e) => e.severity === 'error')) process.exit(1);

for (const [name, art] of Object.entries(out.contracts[target])) {
  console.log(`OK ${name}  bytecode=${art.evm.bytecode.object.length / 2}B  fns=${art.abi.filter((a) => a.type === 'function').length}`);
}
