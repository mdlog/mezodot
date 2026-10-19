import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { BPS, FLASH_FEE_BPS } from '@mezodot/sdk';
import { HUB, SPOKES } from '../chain/env';
import { useAgent } from '../data/hooks';
import { prefersReducedMotion } from '../landing/motion';
import { pct } from '../lib/format';
import { pointAlong, polylineLength, roundedPath, type Point } from '../lib/polyline';
import { ChainLogo } from './Logos';

/** One of the agent's health checks (services/agent/src/health.ts). */
export type AgentCheck = { name: string; ok: boolean; severity: 'critical' | 'warning'; detail: string };

/**
 * GET /status: the agent's /health body, answered with HTTP 200 even while degraded (/health answers 503 then,
 * which the browser cannot tell apart from an agent that is down).
 */
export type AgentStatus = { ok: boolean; status: 'ok' | 'degraded'; modules?: string[]; keeper?: string | null; checks?: AgentCheck[] };

export type AgentState = {
  /** `checking` until the first answer; `offline` when the agent does not answer at all. */
  state: 'checking' | 'ok' | 'degraded' | 'offline';
  /** Failing checks, critical ones first: those are what make the agent degraded. */
  failing: AgentCheck[];
};

/** Reads a /status answer (undefined: not asked yet, null: unreachable) as ok, degraded or offline. */
export function agentState(status: AgentStatus | null | undefined): AgentState {
  if (status === undefined) return { state: 'checking', failing: [] };
  if (status === null) return { state: 'offline', failing: [] };
  const failing = (status.checks ?? []).filter((c) => !c.ok);
  failing.sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'));
  return { state: status.ok === false || status.status === 'degraded' ? 'degraded' : 'ok', failing };
}

const AGENT_WORD: Record<AgentState['state'], string> = { checking: 'checking', ok: 'online', degraded: 'degraded', offline: 'offline' };
const FLASH_FEE = pct(FLASH_FEE_BPS / BPS, 2);

/*
 * Capital topology of Mezodot as a system diagram: the off-chain agent, the spoke chains, Wormhole and the Mezo Hub
 * contracts, connected by the calls, messages, prices and assets that actually move between them. A journey picker
 * walks through one user flow at a time; the overview animates the two Wormhole message lanes.
 * Geometry is in viewBox units (980 × 556); every name below exists in contracts/ or services/agent.
 */

type NodeId = 'agent' | 'supra' | 'spoke' | 'guardians' | 'keeper' | 'vault' | 'oracle' | 'adapter' | 'pools' | 'leverage' | 'tigris' | 'wallet' | 'hub';
type Kind = 'message' | 'call' | 'price' | 'asset';
type Box = { x: number; y: number; w: number; h: number; title: string; sub: string; zone: 'offchain' | 'spoke' | 'hub' | 'dex' | 'you' };

const BOXES: Partial<Record<NodeId, Box>> = {
  agent: { x: 300, y: 38, w: 400, h: 50, title: 'Mezodot agent', sub: 'relayer · liquidator · oracle relay · MCP', zone: 'offchain' },
  supra: { x: 740, y: 38, w: 224, h: 50, title: 'Supra DORA', sub: 'price proof API', zone: 'offchain' },
  spoke: { x: 36, y: 300, w: 170, h: 64, title: 'SpokeGateway', sub: 'locks WETH · USDC', zone: 'spoke' },
  keeper: { x: 426, y: 170, w: 150, h: 64, title: 'KeeperGateway', sub: 'relay · liquidate', zone: 'hub' },
  vault: { x: 606, y: 170, w: 150, h: 64, title: 'VaultManager', sub: 'positions · health', zone: 'hub' },
  oracle: { x: 786, y: 170, w: 150, h: 64, title: 'OracleRouter', sub: 'Pyth · Supra', zone: 'hub' },
  adapter: { x: 426, y: 300, w: 150, h: 64, title: 'WormholeAdapter', sub: 'verifies VAAs', zone: 'hub' },
  pools: { x: 606, y: 300, w: 150, h: 64, title: 'MezodotPool', sub: 'pMUSD · pMEZO', zone: 'hub' },
  // LeverageManager (MUSD loop, on the MUSD pool's flash loan) and SwapLeverageManager (BTC long, on a Tigris flash swap).
  leverage: { x: 786, y: 300, w: 150, h: 64, title: 'Leverage', sub: 'MUSD loop · BTC long', zone: 'hub' },
  // Mezo's own DEX, not a Mezodot contract: the BTC leverage flash-swaps on its MUSD/BTC pool (pool.swap + hook).
  tigris: { x: 786, y: 384, w: 150, h: 48, title: 'Tigris DEX', sub: 'MUSD/BTC pool', zone: 'dex' },
  wallet: { x: 380, y: 486, w: 380, h: 52, title: 'Your wallet', sub: 'one address on Mezo, Base and Ethereum', zone: 'you' },
};
const RING = { x: 316, y: 333, r: 26 };
const PORT: Point = [681, 440];

type Edge = {
  from: NodeId;
  to: NodeId;
  kind: Kind;
  points: Point[];
  /** Arrowheads at both ends (a call that also returns assets, or a two-way flow). */
  both?: boolean;
  label?: { lines: string[]; at: Point; anchor?: 'start' | 'middle' | 'end' };
};

const EDGES = {
  walletSpoke: {
    from: 'wallet',
    to: 'spoke',
    kind: 'asset',
    both: true,
    points: [
      [380, 512],
      [121, 512],
      [121, 364],
    ],
    label: { lines: ['lock · unlock'], at: [250, 504] },
  },
  depositMsg: {
    from: 'spoke',
    to: 'guardians',
    kind: 'message',
    points: [
      [206, 322],
      [292, 322],
    ],
    label: { lines: ['DEPOSIT'], at: [249, 314] },
  },
  depositVaa: {
    from: 'guardians',
    to: 'adapter',
    kind: 'message',
    points: [
      [340, 322],
      [426, 322],
    ],
    label: { lines: ['VAA'], at: [383, 314] },
  },
  releaseMsg: {
    from: 'adapter',
    to: 'guardians',
    kind: 'message',
    points: [
      [426, 344],
      [339, 344],
    ],
    label: { lines: ['RELEASE'], at: [383, 362] },
  },
  releaseVaa: {
    from: 'guardians',
    to: 'spoke',
    kind: 'message',
    points: [
      [293, 344],
      [206, 344],
    ],
    label: { lines: ['VAA'], at: [249, 362] },
  },
  relayHub: {
    from: 'agent',
    to: 'keeper',
    kind: 'call',
    points: [
      [501, 88],
      [501, 170],
    ],
    label: { lines: ['relay · liquidate'], at: [509, 110], anchor: 'start' },
  },
  relaySpoke: {
    from: 'agent',
    to: 'spoke',
    kind: 'call',
    points: [
      [300, 63],
      [28, 63],
      [28, 312],
      [36, 312],
    ],
    label: { lines: ['relay RELEASE VAAs'], at: [164, 56] },
  },
  agentOracle: {
    from: 'agent',
    to: 'oracle',
    kind: 'price',
    points: [
      [680, 88],
      [680, 130],
      [861, 130],
      [861, 170],
    ],
    label: { lines: ['Pyth push · Supra proofs'], at: [770, 122] },
  },
  supraAgent: {
    from: 'supra',
    to: 'agent',
    kind: 'price',
    points: [
      [740, 63],
      [700, 63],
    ],
    label: { lines: ['proofs'], at: [720, 56] },
  },
  keeperVault: {
    from: 'keeper',
    to: 'vault',
    kind: 'call',
    points: [
      [576, 202],
      [606, 202],
    ],
  },
  vaultOracle: {
    from: 'vault',
    to: 'oracle',
    kind: 'price',
    points: [
      [756, 202],
      [786, 202],
    ],
  },
  keeperAdapter: {
    from: 'keeper',
    to: 'adapter',
    kind: 'call',
    points: [
      [501, 234],
      [501, 300],
    ],
    label: { lines: ['VAA'], at: [509, 271], anchor: 'start' },
  },
  adapterVault: {
    from: 'adapter',
    to: 'vault',
    kind: 'call',
    both: true,
    points: [
      [576, 332],
      [591, 332],
      [591, 222],
      [606, 222],
    ],
  },
  vaultPools: {
    from: 'vault',
    to: 'pools',
    kind: 'call',
    both: true,
    points: [
      [681, 234],
      [681, 300],
    ],
    label: { lines: ['borrow', 'repay'], at: [689, 264], anchor: 'start' },
  },
  leverageVault: {
    from: 'leverage',
    to: 'vault',
    kind: 'call',
    points: [
      [786, 312],
      [771, 312],
      [771, 222],
      [756, 222],
    ],
  },
  leveragePools: {
    from: 'leverage',
    to: 'pools',
    kind: 'asset',
    both: true,
    points: [
      [786, 344],
      [756, 344],
    ],
  },
  // A flash swap, not a router trade: the pool pays out first (BTC on an open, MUSD on a close) and is paid in the hook.
  leverageTigris: {
    from: 'leverage',
    to: 'tigris',
    kind: 'asset',
    both: true,
    points: [
      [861, 364],
      [861, 384],
    ],
    label: { lines: ['swap · hook'], at: [869, 378], anchor: 'start' },
  },
  walletHub: {
    from: 'wallet',
    to: 'hub',
    kind: 'call',
    both: true,
    points: [[681, 486], PORT],
    label: { lines: ['supply · borrow · loop · withdraw'], at: [693, 468], anchor: 'start' },
  },
} satisfies Record<string, Edge>;
type EdgeId = keyof typeof EDGES;

type Step = { edge: EdgeId; text: string; fn: string };
export const JOURNEYS: { id: string; label: string; steps: Step[] }[] = [
  { id: 'overview', label: 'Overview', steps: [] },
  {
    id: 'deposit',
    label: 'Deposit collateral',
    steps: [
      { edge: 'walletSpoke', text: 'Lock WETH or USDC in the SpokeGateway on Base or Ethereum.', fn: 'SpokeGateway.deposit(token, amount)' },
      { edge: 'depositMsg', text: 'The gateway publishes a DEPOSIT message through Wormhole Core, finalized only.', fn: 'wormhole.publishMessage(payload)' },
      { edge: 'depositVaa', text: 'Once the block is final (≈ 15–20 min), a quorum of Wormhole guardians signs it into a VAA.', fn: 'signed VAA' },
      { edge: 'relayHub', text: 'The agent, or anyone, relays the VAA to Mezo.', fn: 'KeeperGateway.relayMessage(vaa)' },
      {
        edge: 'keeperAdapter',
        text: 'WormholeAdapter verifies it: right emitter, this destination, never used before.',
        fn: 'WormholeAdapter.receiveMessage(vaa)',
      },
      { edge: 'adapterVault', text: 'VaultManager credits the collateral to your single health factor.', fn: 'VaultManager.creditRemote(account, id, amount)' },
    ],
  },
  {
    id: 'borrow',
    label: 'Borrow',
    steps: [
      { edge: 'agentOracle', text: 'Prices stay fresh: Pyth is pushed on Mezo, the agent serves Supra pull proofs.', fn: 'OracleRouter.updatePrices(updates)' },
      {
        edge: 'walletHub',
        text: 'You borrow MUSD or MEZO, attaching a price update when one is about to expire.',
        fn: 'VaultManager.borrow(marketId, amount, priceUpdate)',
      },
      { edge: 'vaultOracle', text: 'VaultManager values all collateral, on every chain, at prices it accepts now.', fn: 'OracleRouter.getPrice(key)' },
      { edge: 'vaultPools', text: 'The pool lends the MUSD or MEZO straight to your wallet.', fn: 'MezodotPool.borrow(account, amount, receiver)' },
    ],
  },
  {
    id: 'loop',
    label: 'One-tx loop',
    steps: [
      { edge: 'walletHub', text: 'One call with your principal and target leverage.', fn: 'LeverageManager.loop(...)' },
      {
        edge: 'leveragePools',
        text: `The pool flash-lends the extra MUSD (${FLASH_FEE} fee, to reserves); equity plus loan is supplied as pMUSD.`,
        fn: 'MezodotPool.flashLoan(...)',
      },
      { edge: 'leverageVault', text: 'The pMUSD is posted for you and MUSD is borrowed against it.', fn: 'VaultManager.depositCollateralFor · borrowFor' },
      { edge: 'vaultPools', text: 'That borrow repays the flash loan and its fee, all inside the same transaction.', fn: 'flash loan repaid' },
    ],
  },
  {
    // SwapLeverageManager: a flash swap on the Tigris pool; the MUSD pool only lends the debt itself.
    id: 'btc',
    label: 'BTC leverage',
    steps: [
      {
        edge: 'walletHub',
        text: 'Your BTC goes in with a target leverage and a minimum for the swap.',
        fn: 'SwapLeverageManager.open(principal, borrow, minBought, …)',
      },
      {
        edge: 'leverageTigris',
        text: 'A flash swap on the Tigris MUSD/BTC pool: it sends the bought BTC first, never below your minimum, then calls the hook.',
        fn: 'pool.swap(…) → SwapLeverageManager.hook(…)',
      },
      {
        edge: 'leverageVault',
        text: 'In the hook your BTC plus the bought BTC is posted for you, and the MUSD is borrowed against it.',
        fn: 'VaultManager.depositCollateralFor · borrowFor(…, pool, …)',
      },
      {
        edge: 'vaultPools',
        text: 'The MUSD pool lends exactly that borrow straight to the Tigris pool as its payment: no flash loan or flash fee, so your debt is the borrow.',
        fn: 'MezodotPool.borrow(account, amount, tigrisPool)',
      },
    ],
  },
  {
    id: 'liquidate',
    label: 'Liquidation',
    steps: [
      { edge: 'agentOracle', text: 'The agent watches every borrower with fresh prices.', fn: 'oracle relay · Supra proof' },
      { edge: 'relayHub', text: 'Below 1.00× it triggers a liquidation; anyone else could too.', fn: 'KeeperGateway.triggerLiquidation(...)' },
      { edge: 'keeperVault', text: 'Up to half the debt is repaid and collateral plus the bonus is seized.', fn: 'VaultManager.liquidate(...)' },
      { edge: 'vaultPools', text: 'The repayment flows back into the pool.', fn: 'MezodotPool.notifyRepay(...)' },
      { edge: 'releaseMsg', text: 'Seized spoke collateral is released to the liquidator through Wormhole.', fn: 'WormholeAdapter.sendRelease(...)' },
    ],
  },
  {
    id: 'withdraw',
    label: 'Withdraw',
    steps: [
      {
        edge: 'walletHub',
        text: 'You ask for spoke collateral back; the hub checks your health first.',
        fn: 'VaultManager.withdrawRemote(id, amount, recipient, priceUpdate)',
      },
      { edge: 'adapterVault', text: 'VaultManager debits it, then the adapter publishes a RELEASE message.', fn: 'WormholeAdapter.sendRelease(...)' },
      { edge: 'releaseMsg', text: 'Mezo is final at once, so the guardians sign within seconds.', fn: 'signed VAA' },
      { edge: 'releaseVaa', text: 'The VAA is addressed to one spoke and can be consumed once.', fn: 'destination binding · replay guard' },
      { edge: 'relaySpoke', text: 'The agent relays it to the spoke.', fn: 'SpokeGateway.receiveMessage(vaa)' },
      { edge: 'walletSpoke', text: 'The gateway unlocks the tokens to you.', fn: 'transfer to recipient' },
    ],
  },
];

const KINDS: { kind: Kind; label: string }[] = [
  { kind: 'message', label: 'Wormhole message' },
  { kind: 'call', label: 'Contract call' },
  { kind: 'price', label: 'Price data' },
  { kind: 'asset', label: 'Tokens' },
];
const STEP_MS = 2_600;
const LANE_SECONDS = 6;

function NodeBox({ id, dim }: { id: NodeId; dim: boolean }) {
  const b = BOXES[id]!;
  const tall = b.h >= 60;
  return (
    <g className={`topo-node topo-node--${b.zone}${dim ? ' is-dim' : ''}`}>
      <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={10} />
      <rect className="topo-node-accent" x={b.x} y={b.y + 12} width={3} height={b.h - 24} rx={1.5} />
      <text className="topo-node-title" x={b.x + 15} y={b.y + (tall ? 28 : 22)}>
        {b.title}
      </text>
      <text className="topo-node-sub" x={b.x + 15} y={b.y + (tall ? 47 : 40)}>
        {b.sub}
      </text>
    </g>
  );
}

export function Topology() {
  const motion = !prefersReducedMotion();
  // /status, not /health: /health answers 503 while degraded, which would read as offline here.
  const agent = agentState(useAgent<AgentStatus>('/status', 30_000).data);
  const [journeyId, setJourneyId] = useState('overview');
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(motion);
  const journey = JOURNEYS.find((j) => j.id === journeyId)!;
  const steps = journey.steps;
  const active = steps.length > 0;

  useEffect(() => {
    if (!active || !playing || !motion) return;
    const id = setInterval(() => setStep((s) => (s + 1) % steps.length), STEP_MS);
    return () => clearInterval(id);
  }, [active, playing, motion, steps.length]);

  const pick = (id: string) => {
    setJourneyId(id);
    setStep(0);
    setPlaying(motion);
  };

  // What the current journey touches stays lit; the rest of the map dims to context.
  const onPath = new Set<string>(steps.map((s) => s.edge));
  const litNodes = new Set<NodeId>(steps.flatMap((s) => [EDGES[s.edge].from, EDGES[s.edge].to]));
  const current = active && (motion ? steps[step]?.edge : undefined);
  const dimNode = (id: NodeId) => active && !litNodes.has(id);

  return (
    <div className="topo">
      <div className="topo-toolbar">
        <div className="topo-journeys" role="group" aria-label="Show a journey">
          {JOURNEYS.map((j) => (
            <button key={j.id} className={j.id === journeyId ? 'is-active' : ''} aria-pressed={j.id === journeyId} onClick={() => pick(j.id)}>
              {j.label}
            </button>
          ))}
        </div>
        <ul className="topo-legend" aria-label="Legend">
          {KINDS.map((k) => (
            <li key={k.kind}>
              <svg width="26" height="8" aria-hidden="true">
                <line className={`topo-edge topo-edge--${k.kind}`} x1="1" y1="4" x2="25" y2="4" />
              </svg>
              {k.label}
            </li>
          ))}
        </ul>
      </div>

      <div className="topo-canvas">
        <svg
          className={`topo-svg${active ? ' is-journey' : ''}`}
          viewBox="0 0 980 556"
          role="img"
          aria-label="Mezodot topology: the agent off-chain; SpokeGateway on Base and Ethereum Sepolia; Wormhole guardians; and on the Mezo Hub KeeperGateway, VaultManager, OracleRouter, WormholeAdapter, MezodotPool, LeverageManager and SwapLeverageManager beside the Tigris MUSD/BTC pool, used from one wallet."
        >
          <defs>
            {KINDS.map(({ kind }) => (
              <marker key={kind} id={`topo-arrow-${kind}`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path className={`topo-arrow topo-arrow--${kind}`} d="M 1 1 L 9 5 L 1 9 z" />
              </marker>
            ))}
          </defs>

          {/* Bands and zones. */}
          <text className="topo-band" x={16} y={24}>
            OFF-CHAIN
          </text>
          <line className="topo-divider" x1={16} y1={104} x2={964} y2={104} />
          <text className="topo-band" x={16} y={478}>
            YOU
          </text>
          <line className="topo-divider" x1={16} y1={458} x2={964} y2={458} />

          <g className={`topo-zone topo-zone--spoke${active && !litNodes.has('spoke') ? ' is-dim' : ''}`}>
            <rect x={16} y={120} width={210} height={320} rx={14} />
            <text className="topo-zone-label" x={32} y={144}>
              SPOKE CHAINS
            </text>
            {SPOKES.map((s, i) => (
              <g key={s.name}>
                <g transform={`translate(40 ${158 + i * 44})`}>
                  <ChainLogo network={s.name} size={24} />
                </g>
                <text className="topo-chain" x={72} y={169 + i * 44}>
                  {s.label}
                </text>
                <text className="topo-chain-id" x={72} y={184 + i * 44}>
                  Wormhole chain {s.wormholeChainId}
                </text>
              </g>
            ))}
            <text className="topo-note" x={121} y={272} textAnchor="middle">
              collateral stays here
            </text>
          </g>

          <g className={`topo-zone topo-zone--wormhole${active && !litNodes.has('guardians') ? ' is-dim' : ''}`}>
            <rect x={246} y={120} width={140} height={320} rx={14} />
            <text className="topo-zone-label" x={262} y={144}>
              WORMHOLE
            </text>
            <text className="topo-note" x={316} y={200} textAnchor="middle">
              core on every chain
            </text>
            <circle className="topo-ring" cx={RING.x} cy={RING.y} r={RING.r} />
            {Array.from({ length: 19 }, (_, i) => {
              const a = (2 * Math.PI * i) / 19 - Math.PI / 2;
              const signer = i < 13;
              return (
                <circle
                  key={i}
                  className={`topo-guardian${signer ? ' is-signer' : ''}`}
                  cx={RING.x + RING.r * Math.cos(a)}
                  cy={RING.y + RING.r * Math.sin(a)}
                  r={2.6}
                  opacity={signer && !motion ? 1 : 0.3}
                >
                  {motion && signer && (
                    <animate
                      attributeName="opacity"
                      dur={`${LANE_SECONDS / 2}s`}
                      repeatCount="indefinite"
                      calcMode="discrete"
                      keyTimes={`0;${(0.3 + i * 0.03).toFixed(2)};0.92`}
                      values="0.3;1;0.3"
                    />
                  )}
                </circle>
              );
            })}
            {/* The guardian set and its quorum depend on the network (the devnet has a single guardian): no count in the text. */}
            <text className="topo-note" x={RING.x} y={386} textAnchor="middle">
              guardian quorum
            </text>
            <text className="topo-note" x={RING.x} y={402} textAnchor="middle">
              signs when final
            </text>
          </g>

          <g className={`topo-zone topo-zone--hub${active && !litNodes.has('hub') && ![...litNodes].some((n) => BOXES[n]?.zone === 'hub') ? ' is-dim' : ''}`}>
            <rect x={406} y={120} width={558} height={320} rx={14} />
            <g transform="translate(522 131)">
              <ChainLogo network={HUB.name} size={18} />
            </g>
            <text className="topo-zone-label" x={548} y={145}>
              MEZO HUB · CHAIN {HUB.wormholeChainId}
            </text>
          </g>

          {/* Edges under the nodes. */}
          {(Object.keys(EDGES) as EdgeId[]).map((id) => {
            const e: Edge = EDGES[id];
            const state = !active ? '' : id === current ? ' is-current' : onPath.has(id) ? ' is-path' : ' is-dim';
            return (
              <g key={id} className={`topo-link${state}`}>
                <path
                  className={`topo-edge topo-edge--${e.kind}`}
                  d={roundedPath(e.points, 8)}
                  markerEnd={`url(#topo-arrow-${e.kind})`}
                  markerStart={e.both ? `url(#topo-arrow-${e.kind})` : undefined}
                />
                {e.label && (
                  <text className="topo-edge-label" x={e.label.at[0]} y={e.label.at[1]} textAnchor={e.label.anchor ?? 'middle'}>
                    {e.label.lines.map((line, i) => (
                      <tspan key={line} x={e.label!.at[0]} dy={i === 0 ? 0 : 15}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                )}
              </g>
            );
          })}
          <circle className={`topo-port${dimNode('hub') ? ' is-dim' : ''}`} cx={PORT[0]} cy={PORT[1]} r={4.5} />

          {(['agent', 'supra', 'spoke', 'keeper', 'vault', 'oracle', 'adapter', 'pools', 'leverage', 'tigris', 'wallet'] as const).map((id) => (
            <NodeBox key={id} id={id} dim={dimNode(id)} />
          ))}
          {/* Placed so the longest word, "degraded", still ends inside the agent box (its right edge is x = 700). */}
          <g
            className="topo-status"
            aria-label={`agent ${AGENT_WORD[agent.state]}${agent.failing.length > 0 ? `: ${agent.failing.map((c) => c.name).join(', ')}` : ''}`}
          >
            {agent.failing.length > 0 && <title>{agent.failing.map((c) => `${c.name}: ${c.detail}`).join('\n')}</title>}
            <circle
              cx={624}
              cy={58}
              r={4}
              className={agent.state === 'ok' ? 'is-online' : ''}
              style={agent.state === 'degraded' ? { fill: 'var(--amber)' } : undefined}
            />
            <text x={634} y={62}>
              {AGENT_WORD[agent.state]}
            </text>
          </g>

          {/* Overview: one DEPOSIT and one RELEASE crossing, pausing while the guardians sign. */}
          {motion && !active && (
            <>
              {[
                { d: 'M 206 322 L 426 322', label: 'DEPOSIT', begin: 0 },
                { d: 'M 426 344 L 206 344', label: 'RELEASE', begin: LANE_SECONDS / 2 },
              ].map((p) => (
                <g key={p.label} className="topo-packet" opacity={0}>
                  <circle r={9} className="topo-packet-halo" />
                  <circle r={4.5} />
                  <animateMotion
                    dur={`${LANE_SECONDS}s`}
                    begin={`${p.begin}s`}
                    repeatCount="indefinite"
                    calcMode="linear"
                    path={p.d}
                    keyTimes="0;0.35;0.65;1"
                    keyPoints="0;0.5;0.5;1"
                  />
                  <animate
                    attributeName="opacity"
                    dur={`${LANE_SECONDS}s`}
                    begin={`${p.begin}s`}
                    repeatCount="indefinite"
                    keyTimes="0;0.05;0.92;1"
                    values="0;1;1;0"
                  />
                </g>
              ))}
            </>
          )}

          {/* Journey: numbered steps on their edges, and a packet running the current one. */}
          {active &&
            steps.map((s, i) => {
              const [x, y] = pointAlong(EDGES[s.edge].points, 0.5);
              return (
                <g key={`${s.edge}-${i}`} className={`topo-badge${s.edge === current && i === step ? ' is-current' : ''}`} transform={`translate(${x} ${y})`}>
                  <circle r={10} />
                  <text y={4} textAnchor="middle">
                    {i + 1}
                  </text>
                </g>
              );
            })}
          {current && (
            <circle key={`${journeyId}-${step}`} className="topo-runner" r={5}>
              <animateMotion
                ref={(el: SVGAnimateMotionElement | null) => el?.beginElement()}
                begin="indefinite"
                dur={`${Math.max(0.9, polylineLength(EDGES[current].points) / 130)}s`}
                repeatCount="indefinite"
                path={roundedPath(EDGES[current].points, 8)}
              />
            </circle>
          )}
        </svg>
      </div>
      <p className="topo-scroll-hint">Swipe the map sideways to see the Mezo Hub →</p>

      {active ? (
        <div className="topo-steps">
          <div className="topo-steps-head">
            <b>{journey.label}</b>
            {motion && (
              <button className="topo-play" onClick={() => setPlaying((p) => !p)} aria-pressed={playing}>
                {playing ? <Pause size={13} /> : <Play size={13} />} {playing ? 'Pause' : 'Play'}
              </button>
            )}
          </div>
          <ol>
            {steps.map((s, i) => (
              <li key={`${s.edge}-${i}`} className={motion && i === step ? 'is-current' : ''} aria-current={motion && i === step ? 'step' : undefined}>
                <button
                  onClick={() => {
                    setStep(i);
                    setPlaying(false);
                  }}
                >
                  <span className="topo-step-n">{i + 1}</span>
                  <span>
                    {s.text}
                    <code>{s.fn}</code>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <ul className="topo-facts">
          <li>
            <b>Assets stay local.</b> Collateral is locked on its own chain; only messages cross.
          </li>
          <li>
            <b>Messages are verified, once.</b> Guardian-signed VAAs, bound to one destination, consumed a single time.
          </li>
          <li>
            <b>Liquidity is global.</b> Every position on Mezo shares one health factor and one set of pools.
          </li>
        </ul>
      )}
    </div>
  );
}
