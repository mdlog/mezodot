import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowUpRight, Play, RotateCcw } from 'lucide-react';
import type { NetworkName, ProtocolState, UsdPrices } from '@mezodot/sdk';
import { ChainLogo } from '../components/Logos';
import { HUB, SPOKES } from '../chain/env';
import { computeTvl, useAgent, useHubStatus, usePrices, useProtocol } from '../data/hooks';
import { compactUsd, fmt, money, pct } from '../lib/format';
import { collateralTotals } from '../lib/tvl';
import { DEPOSIT_MS, DEPOSIT_STEPS, GUARDIANS, QUORUM, depositAt, guardiansSigned } from './deposit';
import { easeOutCubic, prefersReducedMotion } from './motion';
import { simulateBorrow, spokeCollateral } from './simulate';
import { SvgToken } from './SvgToken';

/** The deposit the hero plays: a round amount of WETH from the first spoke. */
const DEMO_WETH = 0.5;

/** True while the figures come from hub reads that just succeeded: only then may the page say "live". */
export function useHubLive(): boolean {
  const protocol = useProtocol().data;
  const { error } = useHubStatus();
  return protocol !== undefined && error === null;
}

// ---- Scene geometry (viewBox 640 × 520) ----

type Point = { x: number; y: number };
type Curve = { p0: Point; p1: Point; p2: Point; p3: Point };

const HUB_NODE = { x: 474, y: 260, r: 64 };
const NODE_R = 38;
const WALLET: Point = { x: 34, y: 34 };
const PAYOUT: Point = { x: 606, y: 478 };
const RING_R = 24;

const DEPLOYED = SPOKES.filter((s) => s.deployment);

/** Spokes down the left edge, evenly spaced; the first one plays the deposit. */
const NODES = DEPLOYED.map((s, i) => ({
  network: s.name as NetworkName,
  label: s.label,
  wormholeChainId: s.wormholeChainId,
  finalityMin: Math.round(s.finalitySec / 60),
  x: 118,
  y: DEPLOYED.length === 1 ? HUB_NODE.y : 132 + (256 * i) / (DEPLOYED.length - 1),
}));

/** Symmetric cubic from a spoke's edge to the hub's edge: its t = 0.5 point is the geometric midpoint, where the guardians wait. */
const curveFor = (n: { x: number; y: number }): Curve => {
  const p0 = { x: n.x + NODE_R, y: n.y };
  const p3 = { x: HUB_NODE.x - HUB_NODE.r, y: n.y < HUB_NODE.y ? HUB_NODE.y - 16 : n.y > HUB_NODE.y ? HUB_NODE.y + 16 : HUB_NODE.y };
  return { p0, p1: { x: p0.x + 110, y: p0.y }, p2: { x: p3.x - 110, y: p3.y }, p3 };
};
const pathOf = (c: Curve) => `M ${c.p0.x} ${c.p0.y} C ${c.p1.x} ${c.p1.y} ${c.p2.x} ${c.p2.y} ${c.p3.x} ${c.p3.y}`;
const pointOn = (c: Curve, t: number): Point => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return { x: a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x, y: a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y };
};
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

// ---- Playback ----

type Playback = { phase: 'idle'; played: boolean } | { phase: 'running'; step: number; progress: number } | { phase: 'done' };

/** How long the finished deposit stays on screen before the network goes back to its ambient traffic. */
const HOLD_MS = 6_000;

/** Plays the deposit once on request (and once on arrival, motion allowing), frame by frame. */
function useDepositPlayback() {
  const [state, setState] = useState<Playback>({ phase: 'idle', played: false });
  const frame = useRef(0);
  const hold = useRef<number | undefined>(undefined);
  const start = useCallback(() => {
    cancelAnimationFrame(frame.current);
    window.clearTimeout(hold.current);
    const begin = performance.now();
    const tick = (now: number) => {
      const at = depositAt(now - begin);
      if (!at) {
        setState({ phase: 'done' });
        hold.current = window.setTimeout(() => setState({ phase: 'idle', played: true }), HOLD_MS);
        return;
      }
      setState({ phase: 'running', ...at });
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, []);
  useEffect(() => {
    // The page's one unprompted moment: the deposit plays once as the visitor arrives.
    const id = prefersReducedMotion() ? undefined : window.setTimeout(start, 900);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(hold.current);
      cancelAnimationFrame(frame.current);
    };
  }, [start]);
  return { state, start };
}

/** Step index and eased progress; with reduced motion every step is shown at its end state. */
const at = (p: Playback, reduced: boolean): { step: number; t: number } =>
  p.phase === 'running'
    ? { step: p.step, t: reduced ? 1 : easeOutCubic(p.progress) }
    : p.phase === 'done'
      ? { step: DEPOSIT_STEPS.length, t: 1 }
      : { step: -1, t: 0 };

// ---- Hero ----

export function OrbitHero({ onLaunch }: { onLaunch: () => void }) {
  const live = useHubLive();
  const protocol = useProtocol().data;
  const prices = usePrices().data?.prices;
  const playback = useDepositPlayback();
  const replay = playback.state.phase === 'done' || (playback.state.phase === 'idle' && playback.state.played);
  const first = NODES[0];
  const weth = protocol && first ? spokeCollateral(protocol, first.wormholeChainId, 'WETH') : undefined;
  const limit =
    weth && prices?.ETH && prices.MUSD
      ? simulateBorrow({ amount: DEMO_WETH, price: prices.ETH, ltvBps: weth.ltvBps, ltBps: weth.ltBps, musdPrice: prices.MUSD, share: 1 }).limitMusd
      : null;

  return (
    <section className="lp-hero" aria-labelledby="lp-hero-title">
      <div className="lp-container lp-hero-grid">
        <div className="lp-hero-copy">
          <p className="lp-hero-kicker">Capital, in motion.</p>
          <h1 id="lp-hero-title">
            Lock on <ChainWord network="base-sepolia" label="Base" /> or <ChainWord network="eth-sepolia" label="Ethereum" />.{' '}
            <span className="lp-h1-line">
              Borrow on <ChainWord network="mezo-testnet" label="Mezo" />.
            </span>
          </h1>
          <p className="lp-lead">
            Mezodot is a money market on Mezo. Your WETH and USDC stay locked on their own chain while you borrow MUSD against them. Earn yield on MUSD and
            MEZO, or open a BTC long in a single transaction.
          </p>
          <div className="lp-cta-row">
            <button className="lp-button lp-button--primary" onClick={onLaunch}>
              Launch app <ArrowUpRight size={16} />
            </button>
            <button className="lp-button lp-button--ghost" onClick={playback.start} aria-controls="lp-deposit-caption">
              {replay ? <RotateCcw size={15} /> : <Play size={15} />}
              {replay ? 'Replay the deposit' : 'Play a deposit'}
            </button>
          </div>
        </div>
        <OrbitScene playback={playback.state} protocol={protocol} prices={prices} limitMusd={limit} />
      </div>
      <LiveLine live={live} protocol={protocol} prices={prices} />
    </section>
  );
}

/** A chain's name set with its logo, inside the headline. */
function ChainWord({ network, label }: { network: NetworkName; label: string }) {
  return (
    <span className="lp-chain-word">
      <ChainLogo network={network} size={46} />
      {label}
    </span>
  );
}

function LiveLine({ live, protocol, prices }: { live: boolean; protocol: ProtocolState | undefined; prices: UsdPrices | undefined }) {
  const stats = useAgent<{ crossChainBorrowRatio: number | null }>('/stats').data;
  const messages = useAgent<{ status: string }[]>('/messages?limit=500').data;
  const relayed = Array.isArray(messages) ? messages.filter((m) => m.status === 'delivered').length : null;
  const items = [
    protocol && prices ? `${compactUsd(computeTvl(protocol, prices))} locked` : null,
    stats?.crossChainBorrowRatio != null ? `${pct(stats.crossChainBorrowRatio)} of debt backed by spoke collateral` : null,
    relayed !== null ? `${relayed === 500 ? '500+' : relayed} Wormhole message${relayed === 1 ? '' : 's'} relayed` : null,
    protocol ? `block ${fmt(Number(protocol.blockNumber))}` : null,
  ].filter((s): s is string => s !== null);
  return (
    <div className="lp-container">
      <p className="lp-live-line" aria-label="Live protocol figures">
        <span className={live ? 'lp-live is-live' : 'lp-live'}>
          <i aria-hidden="true" />
          {live ? `Live on ${HUB.label}` : HUB.label}
        </span>
        {items.map((s) => (
          <span key={s}>{s}</span>
        ))}
      </p>
    </div>
  );
}

// ---- Scene ----

function OrbitScene({
  playback,
  protocol,
  prices,
  limitMusd,
}: {
  playback: Playback;
  protocol: ProtocolState | undefined;
  prices: UsdPrices | undefined;
  limitMusd: number | null;
}) {
  const id = useId().replace(/:/g, '');
  const reduced = prefersReducedMotion();
  const ambient = !reduced && playback.phase === 'idle';
  const { step, t } = at(playback, reduced);
  const first = NODES[0];
  const curve = first ? curveFor(first) : null;
  const signed = playback.phase === 'running' ? guardiansSigned(playback.step, playback.progress) : playback.phase === 'done' ? guardiansSigned(99, 1) : 0;
  const short = first?.label.split(' ')[0] ?? 'the spoke';
  const totals = protocol && prices ? collateralTotals(protocol, prices) : [];

  // Where each moving piece is during the played deposit.
  const coin = step === 0 && first ? lerp(WALLET, first, t) : null;
  const vaa = curve && step >= 1 && step <= 3 ? pointOn(curve, step === 1 ? 0.5 * t : step === 2 ? 0.5 : 0.5 + 0.5 * t) : null;
  const locked = step > 0 || (step === 0 && t > 0.92);
  const credited = step > 3 || (step === 3 && t > 0.9);
  const payout = step === 4 ? lerp(HUB_NODE, PAYOUT, t) : step > 4 ? PAYOUT : null;

  const captions: Record<string, string> = {
    lock: `Lock ${DEMO_WETH} WETH in the ${short} gateway.`,
    travel: `A Wormhole message leaves ${short}. The WETH stays.`,
    sign: `${signed} of ${GUARDIANS} guardians have signed.`,
    credit: `Mezo credits ${DEMO_WETH} WETH to your position.`,
    borrow: limitMusd ? `Borrow up to ${fmt(limitMusd, 0)} MUSD against it.` : 'Borrow MUSD against it.',
  };
  const caption =
    playback.phase === 'running'
      ? captions[DEPOSIT_STEPS[playback.step].id]
      : playback.phase === 'done'
        ? `Your WETH never left ${short}.`
        : 'Deposits cross as signed messages. The tokens stay where they were locked.';
  const elapsed =
    playback.phase === 'running'
      ? DEPOSIT_STEPS.slice(0, playback.step).reduce((s, x) => s + x.ms, 0) + DEPOSIT_STEPS[playback.step].ms * playback.progress
      : 0;
  const progress = playback.phase === 'done' ? 1 : elapsed / DEPOSIT_MS;

  return (
    <div className="orbit">
      <div className="orbit-stage">
        <svg
          className={`orbit-svg${ambient ? ' is-ambient' : ''}`}
          viewBox="0 0 640 520"
          role="img"
          aria-label={`Deposits on ${NODES.map((n) => n.label).join(' and ')} travel as Wormhole messages, signed by a quorum of guardians, to the Mezo Hub, which credits the collateral`}
        >
          <defs>
            <radialGradient id={`${id}-glow`}>
              <stop offset="0%" stopColor="#6d63f0" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#6d63f0" stopOpacity="0" />
            </radialGradient>
            <radialGradient id={`${id}-core`} cx="35%" cy="30%">
              <stop offset="0%" stopColor="#6a61f0" />
              <stop offset="100%" stopColor="#3a31b8" />
            </radialGradient>
          </defs>

          <circle cx={HUB_NODE.x} cy={HUB_NODE.y} r={170} fill={`url(#${id}-glow)`} />
          <circle className="orbit-ring" cx={HUB_NODE.x} cy={HUB_NODE.y} r={108} />
          <circle className="orbit-ring orbit-ring--outer" cx={HUB_NODE.x} cy={HUB_NODE.y} r={152} />

          {NODES.map((n, i) => {
            const c = curveFor(n);
            const d = pathOf(c);
            const mid = pointOn(c, 0.5);
            const plays = i === 0 && playback.phase !== 'idle';
            return (
              <g key={n.network}>
                <path className="orbit-track" d={d} />
                {ambient && <AmbientMessage d={d} begin={i * 3} />}
                <g transform={`translate(${mid.x} ${mid.y})`}>
                  <circle className="orbit-guardian-ring" r={RING_R} />
                  {Array.from({ length: GUARDIANS }, (_, k) => {
                    const a = (2 * Math.PI * k) / GUARDIANS - Math.PI / 2;
                    return (
                      <circle
                        key={k}
                        className={`orbit-guardian${k < QUORUM ? ' is-signer' : ''}${plays && k < signed ? ' is-signed' : ''}`}
                        cx={RING_R * Math.cos(a)}
                        cy={RING_R * Math.sin(a)}
                        r={2.6}
                        style={ambient ? ({ '--k': k, '--lap': `${i * 3}s` } as CSSProperties) : undefined}
                      />
                    );
                  })}
                  {plays && signed > 0 && (
                    <text className="orbit-signed" y={RING_R + 18} textAnchor="middle">
                      {signed}/{GUARDIANS} signed
                    </text>
                  )}
                </g>
                <circle className={`orbit-node${i === 0 && locked ? ' is-locked' : ''}`} cx={n.x} cy={n.y} r={NODE_R} />
                <g transform={`translate(${n.x - 22} ${n.y - 22})`}>
                  <ChainLogo network={n.network} size={44} />
                </g>
                <text className="orbit-label" x={n.x} y={n.y + NODE_R + 22} textAnchor="middle">
                  {n.label}
                </text>
              </g>
            );
          })}

          <circle className={`orbit-hub${credited ? ' is-credited' : ''}`} cx={HUB_NODE.x} cy={HUB_NODE.y} r={HUB_NODE.r} fill={`url(#${id}-core)`} />
          <g transform={`translate(${HUB_NODE.x - 30} ${HUB_NODE.y - 30})`}>
            <ChainLogo network="mezo-testnet" size={60} />
          </g>
          <text className="orbit-label" x={HUB_NODE.x} y={HUB_NODE.y + HUB_NODE.r + 26} textAnchor="middle">
            Mezo Hub
          </text>

          {coin && (
            <g transform={`translate(${coin.x} ${coin.y})`} className="orbit-coin">
              <SvgToken symbol="WETH" size={30} />
            </g>
          )}
          {vaa && (
            <g transform={`translate(${vaa.x} ${vaa.y})`} className="orbit-vaa">
              <rect x={-19} y={-11} width={38} height={22} rx={6} />
              <text y={4} textAnchor="middle">
                VAA
              </text>
            </g>
          )}
          {credited && (
            <g className="orbit-chip" transform={`translate(${HUB_NODE.x + 20} ${HUB_NODE.y - HUB_NODE.r - 34})`}>
              <rect x={0} y={-15} width={112} height={30} rx={15} />
              <text x={56} y={5} textAnchor="middle">
                +{DEMO_WETH} WETH
              </text>
            </g>
          )}
          {payout && (
            <g transform={`translate(${payout.x} ${payout.y})`} className="orbit-payout">
              <SvgToken symbol="MUSD" size={30} />
              {step > 4 && limitMusd !== null && (
                <text x={-24} y={6} textAnchor="end">
                  {fmt(limitMusd, 0)} MUSD
                </text>
              )}
            </g>
          )}
        </svg>

        {/* Nodes as buttons over the drawing: hover or focus shows what is locked there, read live. */}
        {NODES.map((n) => (
          <NodeTip key={n.network} x={n.x} y={n.y} r={NODE_R} title={n.label}>
            <SpokeHoldings totals={totals} wormholeChainId={n.wormholeChainId} />
            <span>Final after about {n.finalityMin} min, then the guardians sign.</span>
          </NodeTip>
        ))}
        <NodeTip x={HUB_NODE.x} y={HUB_NODE.y} r={HUB_NODE.r} title="Mezo Hub">
          <span>Collateral on every chain backs one health factor per account.</span>
          {protocol && prices && <span>{compactUsd(computeTvl(protocol, prices))} locked across the protocol.</span>}
        </NodeTip>
      </div>

      <div className="orbit-caption">
        <span className="orbit-progress" aria-hidden="true">
          <i style={{ transform: `scaleX(${progress})` }} />
        </span>
        <p id="lp-deposit-caption" aria-live="polite">
          {caption}
        </p>
      </div>
    </div>
  );
}

/** A message running along its route on a loop while nothing is being played. */
function AmbientMessage({ d, begin }: { d: string; begin: number }) {
  return (
    <g className="orbit-ambient" opacity={0}>
      <circle r={5} />
      <animateMotion dur="6s" begin={`${begin}s`} repeatCount="indefinite" calcMode="linear" path={d} keyTimes="0;0.32;0.68;1" keyPoints="0;0.5;0.5;1" />
      <animate attributeName="opacity" dur="6s" begin={`${begin}s`} repeatCount="indefinite" keyTimes="0;0.04;0.95;1" values="0;1;1;0" />
    </g>
  );
}

function NodeTip({ x, y, r, title, children }: { x: number; y: number; r: number; title: string; children: ReactNode }) {
  const style = { left: `${(x / 640) * 100}%`, top: `${(y / 520) * 100}%`, width: `${((2 * r) / 640) * 100}%` } as CSSProperties;
  return (
    <div className="orbit-node-tip" style={style}>
      <button type="button" className="orbit-node-button" aria-label={`${title}: what is locked here`} />
      <div className="orbit-tip" role="tooltip">
        <b>{title}</b>
        {children}
      </div>
    </div>
  );
}

function SpokeHoldings({ totals, wormholeChainId }: { totals: ReturnType<typeof collateralTotals>; wormholeChainId: number }) {
  const accepted = totals.filter((t) => t.collateral.isRemote && t.collateral.chainId === wormholeChainId);
  if (accepted.length === 0) return <span>Reading what is locked here…</span>;
  const here = accepted.filter((t) => t.units > 0);
  if (here.length === 0) return <span>Nothing is locked here yet.</span>;
  const usd = here.reduce((s, t) => s + t.valueUsd, 0);
  const amounts = here.map((t) => `${fmt(t.units, t.collateral.symbol === 'USDC' ? 2 : 4)} ${t.collateral.symbol}`).join(' and ');
  return (
    <span>
      {amounts} locked here ({money(usd)}).
    </span>
  );
}
