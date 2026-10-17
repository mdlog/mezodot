import { useState } from 'react';
import { ArrowRight, ArrowUpRight, Blocks, Check, Code2, Coins, GitBranch, Layers3, Network, Radio, Shield, Waves } from 'lucide-react';
import { DisclaimerBar, PageTitle, SummaryStrip } from '../components/ui';
import { useApp } from '../state/AppContext';

const CONTRACTS = [
  { name: 'VaultManager.sol', role: 'Global state', description: 'Cross-chain user state, LTV limits and health factors.', location: 'Mezo Hub' },
  { name: 'MezodotPool.sol', role: 'Liquidity', description: 'MUSD / MEZO supply, borrows and utilization curves.', location: 'Mezo Hub' },
  { name: 'pToken.sol', role: 'ERC-4626', description: 'Yield-bearing pMUSD and pMEZO receipt shares.', location: 'Mezo Hub' },
  { name: 'WormholeAdapter.sol', role: 'Messaging', description: 'Encodes spoke collateral state and verifies messages.', location: 'Hub ↔ Spoke' },
  { name: 'LeverageManager.sol', role: 'Leverage', description: 'Atomic flash-loan looping route.', location: 'Mezo Hub' },
  { name: 'KeeperGateway.sol', role: 'Automation', description: 'Access-controlled liquidation and rebalance surface.', location: 'Agent layer' },
];

type Tab = 'flow' | 'contracts';

export function Architecture() {
  const { go } = useApp();
  const [tab, setTab] = useState<Tab>('flow');

  return (
    <>
      <PageTitle
        eyebrow="INTELLIGENCE / 06"
        title="Designed as one market."
        subtitle="A central Mezo Hub. External Spokes that keep collateral local. A protocol state model that connects them."
        right={
          <span className="security-pill">
            <Blocks size={14} /> PROTOCOL MAP · MOCK
          </span>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            HUB & SPOKE <i>/</i> SYSTEM MAP
          </>
        }
        time="Wormhole messaging model"
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
                ['contracts', 'Contract map'],
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
              <div className="topology-label">EXTERNAL SPOKES / ARBITRUM · ETHEREUM</div>
              <div className="spoke-chain">
                <span className="chain-disc chain-disc--arb">A</span>
                <div>
                  <b>Arbitrum</b>
                  <small>Collateral source</small>
                </div>
              </div>
              <div className="spoke-assets">
                <span>wETH</span>
                <span>USDC</span>
              </div>
              <div className="spoke-contract">
                <GitBranch size={14} />
                <span>
                  <b>SpokeGateway</b>
                  <small>locks collateral · emits state</small>
                </span>
              </div>
              <div className="spoke-capability">
                <Check size={12} /> Principal stays on-chain
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
                verified message
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
                    <b>MUSD Pool</b>
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
                <b>MUSD → wallet</b>
                <ArrowUpRight size={15} />
              </div>
            </div>
            <div className="topology-agent">
              <div className="agent-node">
                <Radio size={17} />
              </div>
              <span className="topology-label">AGENT LAYER</span>
              <b>Keeper / MCP</b>
              <small>
                risk · liquidation
                <br />
                rebalance proposal
              </small>
            </div>
            <div className="topology-connector topology-connector--agent" />
            <div className="topology-connector topology-connector--message" />
          </div>
        ) : (
          <div className="contract-map-list" role="tabpanel">
            {CONTRACTS.map((c, i) => (
              <div className="contract-row" key={c.name}>
                <span className="contract-index">0{i + 1}</span>
                <span className="contract-hex">
                  <Code2 size={16} />
                </span>
                <span className="contract-name">
                  <b>{c.name}</b>
                  <small>{c.role}</small>
                </span>
                <span className="contract-description">{c.description}</span>
                <span className="contract-location">{c.location}</span>
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
            The Mezo Hub holds core MUSD/MEZO liquidity and the global position view. VaultManager reconciles verified collateral state from external Spokes.
          </p>
        </article>
        <article className="panel arch-note">
          <span className="arch-note-id">02 / SPOKE</span>
          <h3>Collateral stays put.</h3>
          <p>A SpokeGateway accepts eligible collateral on its home chain. Wormhole messaging carries state to the Hub without moving the user's principal.</p>
        </article>
        <article className="panel arch-note">
          <span className="arch-note-id">03 / COMPOSABLE</span>
          <h3>Capital stays productive.</h3>
          <p>ERC-4626-style pTokens capture yield, while LeverageManager and KeeperGateway describe optional automation paths.</p>
        </article>
      </div>

      <DisclaimerBar title="Architecture is a product concept." action="Agent risk view" onAction={() => go('agents')}>
        Contract names and responsibilities reflect the PRD; no deployment is represented by this UI.
      </DisclaimerBar>
    </>
  );
}
