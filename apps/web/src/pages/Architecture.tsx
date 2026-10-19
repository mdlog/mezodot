import { useState } from 'react';
import { Blocks, Code2, Network } from 'lucide-react';
import { BPS, FLASH_FEE_BPS } from '@mezodot/sdk';
import { Topology } from '../components/Topology';
import { AddressLink, InfoBar, PageTitle, SummaryStrip } from '../components/ui';
import { HUB, SPOKES } from '../chain/env';
import { pct } from '../lib/format';
import { useUi } from '../state/UiContext';

/** MezodotPool.FLASH_FEE_BPS, a contract constant: only the MUSD loop pays it (BTC leverage uses a flash swap). */
const FLASH_FEE = pct(FLASH_FEE_BPS / BPS, 2);

type Row = { name: string; role: string; description: string; location: string; address?: string; network?: (typeof SPOKES)[number] | typeof HUB };

function contractRows(): Row[] {
  const c = HUB.deployment?.contracts;
  const rows: Row[] = [
    {
      name: 'VaultManager.sol',
      role: 'Global state',
      description: 'Cross-chain positions, LTV limits, health factors, liquidations.',
      location: 'Mezo Hub',
      address: c?.vaultManager,
      network: HUB,
    },
    {
      name: 'PToken.sol (pMUSD)',
      role: 'ERC-4626 + MezodotPool',
      description: 'MUSD vault & lending pool: kinked rates, reserves, flash loans.',
      location: 'Mezo Hub',
      address: c?.pMUSD,
      network: HUB,
    },
    {
      name: 'PToken.sol (pMEZO)',
      role: 'ERC-4626 + MezodotPool',
      description: 'MEZO vault & lending pool.',
      location: 'Mezo Hub',
      address: c?.pMEZO,
      network: HUB,
    },
    {
      name: 'OracleRouter.sol',
      role: 'Prices',
      description: 'Pyth Core (pushed on Mezo) and keyless Supra pull proofs: per-feed max age, confidence cap and cross-vendor check.',
      location: 'Mezo Hub',
      address: c?.oracleRouter,
      network: HUB,
    },
    {
      name: 'WormholeAdapter.sol',
      role: 'Messaging',
      description: 'Verifies spoke DEPOSIT VAAs, publishes RELEASE messages.',
      location: 'Mezo Hub',
      address: c?.wormholeAdapter,
      network: HUB,
    },
    {
      name: 'LeverageManager.sol',
      role: 'MUSD loop',
      description: `One-transaction MUSD → pMUSD loop on the pool's flash loan (${FLASH_FEE} fee to reserves). Unwind nets the debt against the posted pMUSD (VaultManager.repayWithCollateral): no flash loan, no fee, at any utilization.`,
      location: 'Mezo Hub',
      address: c?.leverageManager,
      network: HUB,
    },
    {
      name: 'SwapLeverageManager.sol',
      role: 'BTC leverage',
      description:
        'One-transaction BTC long on a Tigris flash swap: the pool sends the BTC first, it is posted, and the MUSD borrow pays the pool from the hook (no flash loan or fee; debt = the borrow). Close takes MUSD from the Tigris pool, repays the debt and pays the pool in BTC, so it needs no idle MUSD pool cash.',
      location: 'Mezo Hub',
      address: c?.swapLeverageManager,
      network: HUB,
    },
    {
      name: 'Tigris MUSD/BTC pool',
      role: 'External · flash swaps',
      description: "Mezo's DEX pool SwapLeverageManager trades on (pool.swap + hook); its getAmountOut prices every open and close.",
      location: 'Mezo Hub',
      address: c?.tigrisPool,
      network: HUB,
    },
    {
      name: 'Tigris Router',
      role: 'External · keeper sales',
      description: 'The keeper sells seized BTC back into MUSD through it.',
      location: 'Mezo Hub',
      address: c?.tigrisRouter,
      network: HUB,
    },
    {
      name: 'KeeperGateway.sol',
      role: 'Agent layer',
      description: 'Permissionless liquidations and relays; keeper KPI.',
      location: 'Mezo Hub',
      address: c?.keeperGateway,
      network: HUB,
    },
  ];
  for (const s of SPOKES) {
    rows.push({
      name: 'SpokeGateway.sol',
      role: 'Collateral vault',
      description: 'Locks WETH/USDC, emits DEPOSIT, executes hub RELEASE.',
      location: s.label,
      address: s.deployment?.contracts.spokeGateway,
      network: s,
    });
  }
  return rows;
}

export function Architecture() {
  const { go } = useUi();
  const [tab, setTab] = useState<'flow' | 'contracts'>('flow');

  return (
    <>
      <PageTitle
        eyebrow="INTELLIGENCE"
        title="Designed as one market."
        subtitle="A Mezo Hub that holds liquidity and accounting. Spokes that keep collateral on its home chain. Wormhole Core messages, verified on-chain, connecting them."
        right={
          <span className="security-pill">
            <Blocks size={14} /> {HUB.deployment ? 'DEPLOYED CONTRACTS' : 'CONTRACT MAP'}
          </span>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            HUB & SPOKE <i>/</i> SYSTEM MAP
          </>
        }
        time="Wormhole chain ids: Mezo 50 · Eth Sepolia 10002 · Base Sepolia 10004"
        icon={Network}
      />

      <section className="panel architecture-panel">
        <div className="architecture-panel-head">
          <div>
            <span className="overline">MEZODOT / CAPITAL TOPOLOGY</span>
            <h2>
              Keep assets local.
              <br />
              <em>Make liquidity global.</em>
            </h2>
          </div>
          <div className="architecture-tabs" role="tablist" aria-label="Architecture view">
            {(
              [
                ['flow', 'Capital flow'],
                ['contracts', 'Contracts'],
              ] as const
            ).map(([key, label]) => (
              <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'is-active' : ''} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {tab === 'flow' ? (
          <div role="tabpanel">
            <Topology />
          </div>
        ) : (
          <div className="contract-map-list" role="tabpanel">
            {contractRows().map((c) => (
              <div className="contract-row" key={`${c.name}-${c.location}`}>
                <span className="contract-hex">
                  <Code2 size={16} />
                </span>
                <span className="contract-name">
                  <b>{c.name}</b>
                  <small>{c.role}</small>
                </span>
                <span className="contract-description">{c.description}</span>
                <span className="contract-location">
                  {c.address && c.network ? <AddressLink network={c.network} address={c.address} /> : `${c.location} · not deployed`}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="architecture-notes">
        <article className="panel arch-note">
          <span className="arch-note-id">HUB</span>
          <h3>One place to account.</h3>
          <p>
            MUSD and MEZO liquidity, debt and every position live on Mezo. VaultManager values all collateral with Pyth and Supra prices and enforces one health
            factor.
          </p>
        </article>
        <article className="panel arch-note">
          <span className="arch-note-id">SPOKE</span>
          <h3>Collateral stays put.</h3>
          <p>
            Deposits lock first, then credit. Withdrawals debit the hub first, then release. Hub credit can never exceed tokens locked on the spoke — an
            invariant the tests fuzz.
          </p>
        </article>
        <article className="panel arch-note">
          <span className="arch-note-id">COMPOSABLE</span>
          <h3>Capital stays productive.</h3>
          <p>pMUSD and pMEZO are standard ERC-4626 shares that keep earning while posted as collateral, and plug into any Mezo DEX or vault.</p>
        </article>
      </div>

      <InfoBar title="Open source and tested." action="Agent risk view" onAction={() => go('agents')}>
        Foundry unit, fuzz and invariant tests cover pools, liquidation, flash-loan and flash-swap leverage, and cross-chain replay protection.
      </InfoBar>
    </>
  );
}
