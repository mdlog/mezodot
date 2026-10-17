import { useState } from 'react';
import { ArrowRight, ArrowUpRight, Blocks, Check, Code2, Coins, GitBranch, Layers3, Network, Radio, Shield, Waves } from 'lucide-react';
import { AddressLink, InfoBar, PageTitle, SummaryStrip } from '../components/ui';
import { HUB, SPOKES } from '../chain/env';
import { useUi } from '../state/UiContext';

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
      role: 'Leverage',
      description: 'One-transaction flash-loan loop and unwind.',
      location: 'Mezo Hub',
      address: c?.leverageManager,
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
        eyebrow="INTELLIGENCE / 06"
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
          <div className="topology" role="tabpanel">
            <div className="topology-spoke">
              <div className="topology-label">EXTERNAL SPOKES</div>
              <div className="spoke-chain">
                <span className="chain-disc chain-disc--arb">B</span>
                <div>
                  <b>{SPOKES.map((s) => s.label).join(' · ')}</b>
                  <small>Collateral source</small>
                </div>
              </div>
              <div className="spoke-assets">
                <span>WETH</span>
                <span>USDC</span>
              </div>
              <div className="spoke-contract">
                <GitBranch size={14} />
                <span>
                  <b>SpokeGateway</b>
                  <small>locks collateral · emits DEPOSIT</small>
                </span>
              </div>
              <div className="spoke-capability">
                <Check size={12} /> Principal stays on its chain
              </div>
            </div>
            <div className="topology-bridge">
              <div className="bridge-wave">
                <Waves size={23} />
                <span />
                <span />
                <span />
              </div>
              <div className="topology-bridge-label">WORMHOLE</div>
              <small>
                guardian-signed VAA
                <br />
                not a token bridge
              </small>
              <ArrowRight size={20} />
            </div>
            <div className="topology-hub">
              <div className="hub-heading">
                <div className="topology-label">MEZO HUB / CENTRAL MARKET</div>
                <span className="hub-network-badge">
                  <i /> MEZO
                </span>
              </div>
              <div className="hub-vaults">
                <div className="hub-vault">
                  <Coins size={17} />
                  <span>
                    <b>MezodotPool</b>
                    <small>liquidity & rates</small>
                  </span>
                </div>
                <div className="hub-vault">
                  <Shield size={17} />
                  <span>
                    <b>VaultManager</b>
                    <small>state · LTV · health</small>
                  </span>
                </div>
                <div className="hub-vault">
                  <Layers3 size={17} />
                  <span>
                    <b>pMUSD / pMEZO</b>
                    <small>ERC-4626 receipts</small>
                  </span>
                </div>
              </div>
              <div className="hub-borrow-row">
                <span>Borrow from Hub</span>
                <b>MUSD / MEZO → wallet</b>
                <ArrowUpRight size={15} />
              </div>
            </div>
            <div className="topology-agent">
              <div className="agent-node">
                <Radio size={17} />
              </div>
              <span className="topology-label">AGENT LAYER</span>
              <b>KeeperGateway / MCP</b>
              <small>
                liquidation · relay
                <br />
                risk analytics
              </small>
            </div>
            <div className="topology-connector topology-connector--agent" />
            <div className="topology-connector topology-connector--message" />
          </div>
        ) : (
          <div className="contract-map-list" role="tabpanel">
            {contractRows().map((c, i) => (
              <div className="contract-row" key={`${c.name}-${c.location}`}>
                <span className="contract-index">{String(i + 1).padStart(2, '0')}</span>
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
          <span className="arch-note-id">01 / HUB</span>
          <h3>One place to account.</h3>
          <p>
            MUSD and MEZO liquidity, debt and every position live on Mezo. VaultManager values all collateral with Pyth and Supra prices and enforces one health
            factor.
          </p>
        </article>
        <article className="panel arch-note">
          <span className="arch-note-id">02 / SPOKE</span>
          <h3>Collateral stays put.</h3>
          <p>
            Deposits lock first, then credit. Withdrawals debit the hub first, then release. Hub credit can never exceed tokens locked on the spoke — an
            invariant the tests fuzz.
          </p>
        </article>
        <article className="panel arch-note">
          <span className="arch-note-id">03 / COMPOSABLE</span>
          <h3>Capital stays productive.</h3>
          <p>pMUSD and pMEZO are standard ERC-4626 shares that keep earning while posted as collateral, and plug into any Mezo DEX or vault.</p>
        </article>
      </div>

      <InfoBar title="Open source and tested." action="Agent risk view" onAction={() => go('agents')}>
        Foundry unit, fuzz and invariant tests cover pools, liquidation, flash-loan accounting and cross-chain replay protection.
      </InfoBar>
    </>
  );
}
