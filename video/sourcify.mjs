// Prints the Sourcify match of every live Mezodot contract (hub on Mezo testnet, spokes on Base / Ethereum Sepolia).
// Its output is filmed verbatim in the proof beat.
//
//   node video/sourcify.mjs

export const CONTRACTS = [
  [31611, 'VaultManager', '0x7a2e248Aa4799B3A6ef16a647E4F88A512B854F7'],
  [31611, 'PToken pMUSD', '0x3E6F3719E919cF0Dc01d3019B8df913C472fDfB0'],
  [31611, 'PToken pMEZO', '0x91Ba543447b23e199F0223198e61E6Bb812dAcfc'],
  [31611, 'OracleRouter', '0x5d676a3F6477651C7BdE6442D0FD08aDf0b2eaeD'],
  [31611, 'PythSource', '0x2418E20877E72add21E383a8dD434938FDcCEbe4'],
  [31611, 'SupraSource', '0x5C65CBE1Fb6F81EDcC5cF3dfB9aC6866428719fb'],
  [31611, 'InterestRateModel MUSD', '0x2083d3dCacE0B413Ff34C1Fa14d1f624431168Eb'],
  [31611, 'InterestRateModel MEZO', '0xa0ed4562514168C6AAaaB06E9cB368e80f79E046'],
  [31611, 'WormholeAdapter', '0x8be48D8A0a308F78381aB6Ff7D51e1390BFa2880'],
  [31611, 'LeverageManager', '0x32295B6C7EBd6434D7C930FFf4b5845fccA4d32d'],
  [31611, 'SwapLeverageManager', '0xa0fC085Ed22407972e7086864cAC35C662Ba73CC'],
  [31611, 'KeeperGateway', '0x2e63B1Af8E56E5a7Af02Da36E0B0313f91dedc11'],
  [84532, 'SpokeGateway', '0x587BA0A40aCC1d1DE86654b59118220097C0207D'],
  [11155111, 'SpokeGateway', '0x75E52c9471DC55C2a24b946bC6baDe125AfB7170'],
];

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export async function check() {
  const rows = await Promise.all(
    CONTRACTS.map(async ([chain, name, address]) => {
      const r = await fetch(`https://sourcify.dev/server/v2/contract/${chain}/${address}`);
      const match = r.ok ? ((await r.json()).match ?? 'none') : `http ${r.status}`;
      return { chain, name, address, match };
    }),
  );
  const exact = rows.filter((r) => r.match === 'exact_match').length;
  const lines = rows.map((r) => `${r.match.padEnd(12)} ${String(r.chain).padEnd(9)} ${r.name.padEnd(23)} ${short(r.address)}`);
  lines.push(`${exact}/${rows.length} exact_match`);
  return { exact, total: rows.length, lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { lines } = await check();
  console.log(lines.join('\n'));
}
