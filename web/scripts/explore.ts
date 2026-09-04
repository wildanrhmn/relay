import { WAD, enumerateBuilds, maxMultiplierWad, paytable, realisedRtpWad } from '../src/lib/apparatus';
const n = (w: bigint) => Number(w) / Number(WAD);
const D = 4096;
const builds = enumerateBuilds();
console.log('legal builds:', builds.length);
const sorted = [...builds].sort((a, b) => n(maxMultiplierWad(a)) - n(maxMultiplierWad(b)));
console.log('flattest:', JSON.stringify(sorted[0]), n(maxMultiplierWad(sorted[0])).toFixed(3)+'x');
console.log('spikiest:', JSON.stringify(sorted.at(-1)), n(maxMultiplierWad(sorted.at(-1)!)).toFixed(1)+'x');
const show = (b: number[]) => {
  const rows = paytable(b);
  const hit = Number(rows[0].reachNum) / D;
  const profit = rows.filter(r => r.multWad > WAD).reduce((a, r) => a + Number(r.exactNum)/D, 0);
  console.log(`\n${JSON.stringify(b)}  rtp=${n(realisedRtpWad(b)).toFixed(6)}  any-pay=${(hit*100).toFixed(1)}%  profit=${(profit*100).toFixed(1)}%  top=${n(maxMultiplierWad(b)).toFixed(2)}x`);
  console.log('  ' + rows.map(r => `d${r.depth}:${n(r.multWad).toFixed(2)}x@${(Number(r.exactNum)/D*100).toFixed(2)}%`).join(' '));
};
[[4,4,4],[3,3,3,3],[2,2,2,2,2,2],[4,4,1,1,1,1],[3,2,2,2,1,1,1],[2,2,1,1,1,1,1,1,1,1],[1,1,1,1,1,1,1,1,1,1,1,1]].forEach(show);
