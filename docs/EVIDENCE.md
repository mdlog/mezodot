# On-chain evidence

Everything here ran on a public testnet and can be checked without trusting this repository. The live app shows the same list at `#/proof`. Addresses are in [`packages/sdk/src/deployments`](../packages/sdk/src/deployments).

Explorers: [Mezo testnet](https://explorer.test.mezo.org), [Base Sepolia](https://sepolia.basescan.org), [Ethereum Sepolia](https://sepolia.etherscan.io).

To check the whole deployment yourself (235 checks, read-only):

```bash
pnpm install && pnpm verify:deployment mezo-testnet
```

## Source verification

All hub contracts are exact matches on Sourcify, under `https://repo.sourcify.dev/31611/<address>`, including the three added for Wave 2:

| Contract         | Address                                      |
| ---------------- | -------------------------------------------- |
| TroveRouter      | `0xdDC76ff55B3986F72eCe99369d4389133E5FF75C` |
| SkipSource       | `0x66DB48e0Af5aDE6e18A502BD34eeDA922032d165` |
| TigrisTwapSource | `0x5EB962ba29CC4430bEAcf43027fdb7870FcD2BF3` |

Mezo's Blockscout answers "Unable to verify" for contracts built with solc's via-IR pipeline, which every hub contract uses, so they show as unverified there (DEPLOY.md, step 4). Both spoke gateways are also verified on Blockscout.

## Paths exercised

### MUSD market and BTC leverage

| Step           | Transaction                                                          |
| -------------- | -------------------------------------------------------------------- |
| Supply MUSD    | `0x1fa92388f6149df20b2792d4ea555902ec3f7e462f5732e287500a0b90a71c78` |
| Open MUSD loop | `0xa0db424c5a86804a1fa4742502fc1091785599adf10a9ab68c03d25eda14a6ed` |
| Open BTC long  | `0x18ac216ed3957e212160b7172e4417acdef0c23a0b5dc618038e4ad472c71d7a` |

### Cross-chain collateral

| Step                 | Transaction                                                          |
| -------------------- | -------------------------------------------------------------------- |
| Lock on Base Sepolia | `0x653957754d808d362ce2fae7404ee2ac5d06c2fd13b0eeae9f9a4a81384ac706` |

The spoke gateway on Base Sepolia is `0x587BA0A4…207D` (full address in `base-sepolia.json`), verified on Blockscout.

### MEZO market

Account `0x496daedE9076C9349fE4E775a51C00C98b501C39`, which still holds this position.

| Step            | Transaction                                                          |
| --------------- | -------------------------------------------------------------------- |
| Post 0.001 BTC  | `0x372a3a1eef1045985e56b72001e8648545ba5f7f176b281b8caf4c6ab0bf83bb` |
| Borrow 450 MEZO | `0xf89123da225c08d0262f7f0361a885904007bdb7a1bf2b48e187a55abc526e1b` |
| Repay 50 MEZO   | `0x5e4d3798a561ce2ad50453925b7c2324642deefdd1f6bfbfcc3d55c343da32d5` |

### pMEZO as collateral

Account `0x8184A07E2D33F285DDf1a9deCDad3D76318A653E`.

| Step            | Transaction                                                          |
| --------------- | -------------------------------------------------------------------- |
| Supply 400 MEZO | `0xf61074fd660efe71ffe922daea3c9776addcd77e656ae93d651062fcad6d4788` |
| Post pMEZO      | `0x0258bf576a375c12d88b9c63d52bbc8b7b06daefb9df875111265573743cbb14` |
| Borrow 1.1 MUSD | `0xf00004ba92cbe9a62323928bf4c48fd48f1249f2736613ae896676992780468d` |
| Repay the rest  | `0xdfc8de07b4b11ffc85bb0d9317cf04edd476a1d4ee07eb2c6ed8cf1f7dd24c5b` |
| Withdraw pMEZO  | `0x7ef2c8c7489f8fb334718e16b5f8579121ea96c357a228c641e48b2abc37bc06` |
| Redeem for MEZO | `0x2b107679b24d3c763115bfcaefa152b4593a0a8bc990963b67b8f0dd05236d6f` |

### Keeper liquidation

**This liquidation was staged.** A healthy test position cannot become liquidatable on demand, so the owner lowered pMEZO's limits, using the same `setCollateralParams` call any listing change uses, from LTV 50% / LT 60% to LTV 10% / LT 20%. No other account held pMEZO collateral at the time. The limits stayed lowered for about eight minutes, longer than needed, because the script that was meant to restore them after the first liquidation read the debt with a broken call and ran to its timeout. The bonus stayed at 10%.

Nothing else was staged. The agent was already running under pm2 with its normal configuration. It found the account by itself and liquidated it twice, at the 50% close factor, then redeemed and sold what it seized.

Sale proceeds are **not** a realistic profit figure. The keeper received 44.36 and 7.64 MUSD for what it seized against repayments of 0.55 and 0.275 MUSD, because the testnet MEZO/MUSD pool held about 79 MUSD against 81 MEZO, roughly 150 times the oracle price. Those two sales moved it to about 27 MUSD against 234 MEZO, still about 20 times the oracle price. A liquid market would pay about the oracle price, leaving the keeper the 10% bonus less the protocol's share and gas.

| Step                                 | Transaction                                                          |
| ------------------------------------ | -------------------------------------------------------------------- |
| Owner lowers pMEZO limits            | `0x0d606aa580925a4558c5520e76b52eca13a817deb10402e836a5111fa1378e81` |
| Keeper liquidates, 0.55 MUSD repaid  | `0x8e4d1cc06311e39bd9ad512565ede315bdaf4ea0f7265f5e570972bed3c4c3ca` |
| Keeper redeems seized pMEZO          | `0xf2ba2220cc9a7632559a3e5fdcaf046b6a58b068aa23907b3a39fe2d15e3b3dc` |
| Keeper sells the MEZO on Tigris      | `0x4147675c74b570f75f945f8020c93631587eaf0db82c57ace08035145b0d905c` |
| Keeper liquidates, 0.275 MUSD repaid | `0xc7114ee009b0e3d85589094751edfc4c85cec64faa9f955bfa4ddb718dc17541` |
| Keeper redeems seized pMEZO          | `0x763de5fecab6df2c2cc75bc149a6b813a2bdcdb701d5f425404b9f397136da4f` |
| Keeper sells the MEZO on Tigris      | `0x67678d10584d43184ce2ba2e0f7200906a6e15b3e7b14aaef8e2abf75ec6f1e7` |
| Owner restores pMEZO limits          | `0x150aa9af55f89e2ce55ef005ce8d9ffa70b1c7eefd3abd58a240fa5530a2f168` |

### Keyless oracle legs

BTC reads Mezo's Skip precompile first, with Supra as the cross-check, so it no longer depends on anyone holding a Pyth key. MUSD and MEZO keep Mezo's Pyth push as the price, with a Tigris TWAP that takes over only when the push goes stale.

| Step                    | Transaction                                                          |
| ----------------------- | -------------------------------------------------------------------- |
| Deploy SkipSource       | `0xc8511d37ef65dc35ce963f579479b9f581c821d2256f0b4b53bff31bed3a4e77` |
| Deploy TigrisTwapSource | `0x666e8b98fe14ab9a9cc20a6d301a84aff7cafd1254b1c99d5876845fc53666d6` |
| Register Skip           | `0x5635d8120bc0bee4a55027b2768bb495152ef156a3c3f8ec66834da9a6532dd6` |
| Register TWAP           | `0x37ba0324230d727637a38802bf30b770a3eac2cf83b33e3f6d7693e5f57a33ba` |
| BTC feed                | `0x556e698037e46267718b4e61279503d61d5783fd36fa467d1fa8e4941559fb7e` |
| MUSD feed               | `0x5f7948659d172ee1285d928b4c4eaf889b27fb67960605562db0cec49e67ed95` |
| MEZO feed               | `0x8a4311c19f17c23b9d36a20a948838430cadbdee655d9eb561362318c80a0f5d` |

The MEZO fallback does not work yet: it returns no price, because the testnet pool sits far outside its 15% band. That is the fallback refusing a bad price, as designed, so MEZO still rests on the Pyth push alone. The MUSD fallback read $0.984 against a Pyth price of $0.991 at deployment.

### TroveRouter

| Step               | Transaction                                                          |
| ------------------ | -------------------------------------------------------------------- |
| Deploy TroveRouter | `0x4f7960d748e339e97e206a6652daf36b34b0f4b79694bda12a1c6e12f7281909` |

**Not yet exercised on testnet.** A Mezo trove needs at least 2,000 MUSD of debt, so about 0.04 BTC of collateral. Until a full open, repay and close runs on testnet, the evidence is the fork suite, which drives Mezo's real contracts with real signatures:

```bash
MEZO_FORK_RPC=https://rpc.test.mezo.org forge test --root contracts --match-contract ForkTrove -vv
```

## What this does not show

- **Outside users.** The accounts above are the team's own test wallets.
- **Size.** Amounts are small: testnet faucets limit them.
- **An audit.** The contracts have not had an external audit.
