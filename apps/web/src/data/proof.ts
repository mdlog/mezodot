import type { NetworkName } from '@mezodot/sdk';

/**
 * Transactions that exercised each path on live testnets, for the Proof page. docs/EVIDENCE.md carries the same list
 * with its context, and a test keeps the two in step.
 */
export type ProofTx = { label: string; hash: `0x${string}`; network: NetworkName };
export type ProofSection = { title: string; note: string; txs: ProofTx[] };

const mezo = (label: string, hash: `0x${string}`): ProofTx => ({ label, hash, network: 'mezo-testnet' });

export const PROOF: ProofSection[] = [
  {
    title: 'MUSD market and BTC leverage',
    note: 'Supply MUSD, loop it, and open a BTC long through a Tigris flash swap.',
    txs: [
      mezo('Supply MUSD', '0x1fa92388f6149df20b2792d4ea555902ec3f7e462f5732e287500a0b90a71c78'),
      mezo('Open MUSD loop', '0xa0db424c5a86804a1fa4742502fc1091785599adf10a9ab68c03d25eda14a6ed'),
      mezo('Open BTC long', '0x18ac216ed3957e212160b7172e4417acdef0c23a0b5dc618038e4ad472c71d7a'),
    ],
  },
  {
    title: 'Cross-chain collateral',
    note: 'A deposit locked on a spoke, credited as collateral on the Mezo hub through Wormhole.',
    txs: [{ label: 'Lock on Base Sepolia', hash: '0x653957754d808d362ce2fae7404ee2ac5d06c2fd13b0eeae9f9a4a81384ac706', network: 'base-sepolia' }],
  },
  {
    title: 'MEZO market',
    note: 'BTC posted as collateral, MEZO borrowed against it, part of it repaid.',
    txs: [
      mezo('Post BTC', '0x372a3a1eef1045985e56b72001e8648545ba5f7f176b281b8caf4c6ab0bf83bb'),
      mezo('Borrow 450 MEZO', '0xf89123da225c08d0262f7f0361a885904007bdb7a1bf2b48e187a55abc526e1b'),
      mezo('Repay 50 MEZO', '0x5e4d3798a561ce2ad50453925b7c2324642deefdd1f6bfbfcc3d55c343da32d5'),
    ],
  },
  {
    title: 'pMEZO as collateral',
    note: 'MEZO supplied, its shares posted, MUSD borrowed against them. After the liquidations below: repaid, withdrawn and redeemed.',
    txs: [
      mezo('Supply 400 MEZO', '0xf61074fd660efe71ffe922daea3c9776addcd77e656ae93d651062fcad6d4788'),
      mezo('Post pMEZO', '0x0258bf576a375c12d88b9c63d52bbc8b7b06daefb9df875111265573743cbb14'),
      mezo('Borrow 1.1 MUSD', '0xf00004ba92cbe9a62323928bf4c48fd48f1249f2736613ae896676992780468d'),
      mezo('Repay the rest', '0xdfc8de07b4b11ffc85bb0d9317cf04edd476a1d4ee07eb2c6ed8cf1f7dd24c5b'),
      mezo('Withdraw pMEZO', '0x7ef2c8c7489f8fb334718e16b5f8579121ea96c357a228c641e48b2abc37bc06'),
      mezo('Redeem for MEZO', '0x2b107679b24d3c763115bfcaefa152b4593a0a8bc990963b67b8f0dd05236d6f'),
    ],
  },
  {
    title: 'Keeper liquidation',
    note:
      "A test, staged in the open: the owner lowered pMEZO's liquidation threshold from 60% to 20% for about eight minutes, when only this test account held pMEZO collateral, then restored it. " +
      'The running agent found the account and liquidated it twice on its own. Its sales earned far more than the seized collateral was worth because the testnet MEZO/MUSD pool trades well above the oracle price, which a real market would not offer.',
    txs: [
      mezo('Owner lowers pMEZO limits', '0x0d606aa580925a4558c5520e76b52eca13a817deb10402e836a5111fa1378e81'),
      mezo('Keeper liquidates: 0.55 MUSD repaid', '0x8e4d1cc06311e39bd9ad512565ede315bdaf4ea0f7265f5e570972bed3c4c3ca'),
      mezo('Keeper redeems seized pMEZO', '0xf2ba2220cc9a7632559a3e5fdcaf046b6a58b068aa23907b3a39fe2d15e3b3dc'),
      mezo('Keeper sells the MEZO on Tigris', '0x4147675c74b570f75f945f8020c93631587eaf0db82c57ace08035145b0d905c'),
      mezo('Keeper liquidates: 0.275 MUSD repaid', '0xc7114ee009b0e3d85589094751edfc4c85cec64faa9f955bfa4ddb718dc17541'),
      mezo('Keeper redeems seized pMEZO', '0x763de5fecab6df2c2cc75bc149a6b813a2bdcdb701d5f425404b9f397136da4f'),
      mezo('Keeper sells the MEZO on Tigris', '0x67678d10584d43184ce2ba2e0f7200906a6e15b3e7b14aaef8e2abf75ec6f1e7'),
      mezo('Owner restores pMEZO limits', '0x150aa9af55f89e2ce55ef005ce8d9ffa70b1c7eefd3abd58a240fa5530a2f168'),
    ],
  },
  {
    title: 'Keyless oracle legs',
    note: "BTC now reads Mezo's own Skip feed first, with Supra as the cross-check. MUSD and MEZO keep Mezo's Pyth push, with a Tigris TWAP that takes over only when the push goes stale and stays inside a band.",
    txs: [
      mezo('Deploy SkipSource', '0xc8511d37ef65dc35ce963f579479b9f581c821d2256f0b4b53bff31bed3a4e77'),
      mezo('Deploy TigrisTwapSource', '0x666e8b98fe14ab9a9cc20a6d301a84aff7cafd1254b1c99d5876845fc53666d6'),
      mezo('Register Skip', '0x5635d8120bc0bee4a55027b2768bb495152ef156a3c3f8ec66834da9a6532dd6'),
      mezo('Register TWAP', '0x37ba0324230d727637a38802bf30b770a3eac2cf83b33e3f6d7693e5f57a33ba'),
      mezo('BTC feed', '0x556e698037e46267718b4e61279503d61d5783fd36fa467d1fa8e4941559fb7e'),
      mezo('MUSD feed', '0x5f7948659d172ee1285d928b4c4eaf889b27fb67960605562db0cec49e67ed95'),
      mezo('MEZO feed', '0x8a4311c19f17c23b9d36a20a948838430cadbdee655d9eb561362318c80a0f5d'),
    ],
  },
  {
    title: 'TroveRouter',
    note: 'BTC to a Mezo trove to pMUSD in one transaction. Deployed and tested against a fork of the live contracts; a full open, repay and close on testnet is still to come.',
    txs: [mezo('Deploy TroveRouter', '0x4f7960d748e339e97e206a6652daf36b34b0f4b79694bda12a1c6e12f7281909')],
  },
];

/** Contracts a reader may want to inspect, by their key in the deployment record. All exact matches on Sourcify. */
export const PROOF_CONTRACTS: {
  label: string;
  key:
    | 'vaultManager'
    | 'oracleRouter'
    | 'pMUSD'
    | 'pMEZO'
    | 'leverageManager'
    | 'swapLeverageManager'
    | 'keeperGateway'
    | 'wormholeAdapter'
    | 'troveRouter'
    | 'skipSource'
    | 'twapSource';
}[] = [
  { label: 'VaultManager', key: 'vaultManager' },
  { label: 'OracleRouter', key: 'oracleRouter' },
  { label: 'pMUSD', key: 'pMUSD' },
  { label: 'pMEZO', key: 'pMEZO' },
  { label: 'LeverageManager', key: 'leverageManager' },
  { label: 'SwapLeverageManager', key: 'swapLeverageManager' },
  { label: 'KeeperGateway', key: 'keeperGateway' },
  { label: 'WormholeAdapter', key: 'wormholeAdapter' },
  { label: 'TroveRouter', key: 'troveRouter' },
  { label: 'SkipSource', key: 'skipSource' },
  { label: 'TigrisTwapSource', key: 'twapSource' },
];
