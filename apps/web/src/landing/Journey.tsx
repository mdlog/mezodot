import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { BPS, FLASH_FEE_BPS, type ProtocolState } from '@mezodot/sdk';
import { ChainLogo } from '../components/Logos';
import { SPOKES } from '../chain/env';
import { useProtocol } from '../data/hooks';
import { pct } from '../lib/format';
import { GUARDIANS, QUORUM } from './deposit';
import { SvgToken } from './SvgToken';

type Chapter = { key: string; title: string; body: string; caption: string };

const finality = (name: string) => {
  const s = SPOKES.find((x) => x.name === name);
  return s ? Math.round(s.finalitySec / 60) : null;
};

/** "WETH 75%, USDC 80%": the loan-to-value the hub sets for each spoke token (a range where chains differ). */
function spokeLtvs(protocol: ProtocolState | undefined): string | null {
  const bySymbol = new Map<string, number[]>();
  for (const c of protocol?.collaterals ?? []) if (c.isRemote) bySymbol.set(c.symbol, [...(bySymbol.get(c.symbol) ?? []), c.ltvBps / 100]);
  if (bySymbol.size === 0) return null;
  return [...bySymbol]
    .map(([symbol, ltvs]) => {
      const lo = Math.min(...ltvs);
      const hi = Math.max(...ltvs);
      return `${symbol} ${lo === hi ? `${lo}%` : `${lo}–${hi}%`}`;
    })
    .join(', ');
}

function chapters(protocol: ProtocolState | undefined): Chapter[] {
  const base = finality('base-sepolia');
  const eth = finality('eth-sepolia');
  const ltvs = spokeLtvs(protocol);
  return [
    {
      key: 'lock',
      title: 'Lock WETH or USDC where it already is',
      body: 'Deposit into the SpokeGateway on Base or Ethereum. The tokens stay in that contract, on their own chain.',
      caption: 'Locked in the Base gateway',
    },
    {
      key: 'sign',
      title: 'Guardians sign the deposit',
      body: `Once the block is final${base && eth ? `, about ${base} minutes on Base and ${eth} on Ethereum` : ''}, ${QUORUM} of Wormhole's ${GUARDIANS} guardians sign a message. Only that message crosses chains.`,
      caption: `${QUORUM} of ${GUARDIANS} guardians signed`,
    },
    {
      key: 'credit',
      title: 'Mezo credits your collateral',
      body: 'The hub checks the signatures and adds the deposit to your position. One health factor covers BTC, pTokens and every spoke.',
      caption: 'Credited on Mezo',
    },
    {
      key: 'borrow',
      title: 'Borrow MUSD or MEZO',
      body: ltvs
        ? `Up to each collateral's loan-to-value, read from the hub: ${ltvs}.`
        : "Up to each collateral's loan-to-value, set on the hub for every token and chain.",
      caption: 'MUSD in your wallet',
    },
    {
      key: 'loop',
      title: 'Loop MUSD in one transaction',
      body: `The MUSD pool's flash loan supplies, borrows and repays in one go, up to 3×. The ${pct(FLASH_FEE_BPS / BPS, 2)} fee goes to the pool's reserves.`,
      caption: 'Up to 3× in one transaction',
    },
    {
      key: 'long',
      title: 'Go long BTC through Tigris',
      body: 'A Tigris flash swap delivers the BTC first. It is posted as collateral, and the MUSD you borrow pays the pool. No flash fee.',
      caption: 'BTC first, MUSD pays the pool',
    },
    {
      key: 'withdraw',
      title: 'Take it home when your health allows',
      body: 'Mezo debits your collateral first, then a release message unlocks the tokens on their own chain.',
      caption: 'Released on Base',
    },
  ];
}

/** The chapter crossing the middle of the viewport. */
function useActiveChapter(count: number) {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.index));
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    refs.current.slice(0, count).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [count]);
  return { active, refs };
}

export function Journey() {
  const protocol = useProtocol().data;
  const list = chapters(protocol);
  const { active, refs } = useActiveChapter(list.length);
  return (
    <section id="journey" className="lp-journey" aria-labelledby="lp-journey-title">
      <div className="lp-container">
        <header className="lp-section-head">
          <h2 id="lp-journey-title">From a spoke chain to MUSD, and back</h2>
          <p>Seven steps, each settled by a contract. Scroll to follow one deposit through all of them.</p>
        </header>
        <div className="lp-journey-grid">
          <ol className="lp-chapters">
            {list.map((c, i) => (
              <li
                key={c.key}
                ref={(el) => {
                  refs.current[i] = el;
                }}
                data-index={i}
                className={i === active ? 'is-active' : undefined}
                aria-current={i === active ? 'step' : undefined}
              >
                <span className="lp-chapter-num">{i + 1}</span>
                <h3>{c.title}</h3>
                <p>{c.body}</p>
              </li>
            ))}
          </ol>
          <div className="lp-stage">
            <JourneyScene step={active} caption={list[active].caption} />
          </div>
        </div>
      </div>
    </section>
  );
}

// ---- Scene (viewBox 560 × 440): one deposit, drawn at the step being read ----

const WALLET = { x: 66, y: 370 };
const VAULT = { x: 126, y: 210 };
const RING = { x: 280, y: 104 };
const HUB = { x: 432, y: 210 };
// Tigris sits below and right of the hub, clear of the collateral bar under it.
const POOL = { x: 498, y: 386 };

const move = (p: { x: number; y: number }, visible = true): CSSProperties => ({ transform: `translate(${p.x}px, ${p.y}px)`, opacity: visible ? 1 : 0 });

function JourneyScene({ step, caption }: { step: number; caption: string }) {
  const released = step === 6;
  const signed = step === 1 || step === 2 || released;
  const credited = step >= 2 && step <= 5;
  return (
    <div className="journey-scene" data-step={step}>
      <svg viewBox="0 0 560 440" aria-hidden="true">
        {/* Routes */}
        <path className="journey-track" d={`M ${VAULT.x + 46} ${VAULT.y - 18} Q ${RING.x - 20} ${RING.y - 10} ${RING.x - 34} ${RING.y}`} />
        <path className="journey-track" d={`M ${RING.x + 34} ${RING.y} Q ${HUB.x - 10} ${RING.y - 6} ${HUB.x - 40} ${HUB.y - 44}`} />
        <path
          className={`journey-track${step === 3 ? ' is-active' : ''}`}
          d={`M ${HUB.x - 52} ${HUB.y + 32} Q ${HUB.x - 150} ${WALLET.y + 10} ${WALLET.x + 30} ${WALLET.y}`}
        />
        <path
          className={`journey-track${step === 5 ? ' is-active' : ''}`}
          d={`M ${HUB.x + 54} ${HUB.y + 24} Q ${HUB.x + 104} ${HUB.y + 90} ${POOL.x + 10} ${POOL.y - 28}`}
          style={{ opacity: step === 5 ? 1 : 0 }}
        />

        {/* You */}
        <g transform={`translate(${WALLET.x} ${WALLET.y})`}>
          <circle className="journey-you" r={28} />
          <rect className="journey-wallet" x={-12} y={-9} width={24} height={18} rx={4} />
          <circle className="journey-wallet-clasp" cx={6} cy={0} r={2.4} />
          <text className="journey-label" y={46} textAnchor="middle">
            You
          </text>
        </g>

        {/* The spoke gateway, locked until the release */}
        <g transform={`translate(${VAULT.x} ${VAULT.y})`}>
          <rect className="journey-vault" x={-46} y={-46} width={92} height={92} rx={22} />
          <g transform="translate(-20 -26)">
            <ChainLogo network="base-sepolia" size={40} />
          </g>
          <text className="journey-lock" y={34} textAnchor="middle">
            {released ? 'unlocked' : 'locked'}
          </text>
          <text className="journey-label" y={70} textAnchor="middle">
            Base gateway
          </text>
        </g>

        {/* Guardians */}
        <g transform={`translate(${RING.x} ${RING.y})`}>
          <circle className="journey-ring" r={30} />
          {Array.from({ length: GUARDIANS }, (_, k) => {
            const a = (2 * Math.PI * k) / GUARDIANS - Math.PI / 2;
            return (
              <circle
                key={k}
                className={`journey-guardian${signed && k < QUORUM ? ' is-signed' : ''}`}
                cx={30 * Math.cos(a)}
                cy={30 * Math.sin(a)}
                r={3.2}
                style={{ transitionDelay: signed ? `${k * 40}ms` : '0ms' }}
              />
            );
          })}
          <text className="journey-label" y={54} textAnchor="middle">
            Wormhole guardians
          </text>
        </g>

        {/* The hub */}
        <g transform={`translate(${HUB.x} ${HUB.y})`}>
          <circle className={`journey-hub${credited ? ' is-credited' : ''}`} r={58} />
          <g transform="translate(-28 -28)">
            <ChainLogo network="mezo-testnet" size={56} />
          </g>
          <g className="journey-loop" style={{ opacity: step === 4 ? 1 : 0 }}>
            <circle r={72} />
            <text y={-80} textAnchor="middle">
              3×
            </text>
          </g>
          <text className="journey-label" y={98} textAnchor="middle">
            Mezo Hub
          </text>
        </g>
        <g transform={`translate(${HUB.x - 50} ${HUB.y + 114})`} style={{ opacity: credited ? 1 : 0 }} className="journey-bar">
          <rect width={100} height={8} rx={4} />
          <rect className="journey-bar-fill" width={100} height={8} rx={4} style={{ transform: `scaleX(${credited ? 1 : 0})` }} />
          <text x={50} y={26} textAnchor="middle">
            collateral
          </text>
        </g>

        {/* Tigris, for the BTC long */}
        <g transform={`translate(${POOL.x} ${POOL.y})`} style={{ opacity: step === 5 ? 1 : 0 }} className="journey-pool">
          <rect x={-54} y={-26} width={108} height={52} rx={14} />
          <text y={6} textAnchor="middle">
            Tigris pool
          </text>
        </g>

        {/* Moving pieces */}
        <g className="journey-piece" style={move(released ? WALLET : { x: VAULT.x + 40, y: VAULT.y + 40 })}>
          <SvgToken symbol="WETH" size={30} />
        </g>
        <g className="journey-piece journey-vaa" style={move(step === 1 ? RING : step === 0 || released ? VAULT : HUB, step === 1 || step === 2 || released)}>
          <rect x={-20} y={-12} width={40} height={24} rx={6} />
          <text y={4} textAnchor="middle">
            VAA
          </text>
        </g>
        <g className="journey-piece" style={move(step === 3 ? { x: WALLET.x + 34, y: WALLET.y - 30 } : HUB, step === 3)}>
          <SvgToken symbol="MUSD" size={30} />
        </g>
        <g className="journey-piece" style={move(step === 5 ? { x: HUB.x + 56, y: HUB.y + 30 } : POOL, step === 5)}>
          <SvgToken symbol="BTC" size={30} />
        </g>
      </svg>
      <p className="journey-caption">{caption}</p>
    </div>
  );
}
