import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  Coins,
  GitBranch,
  Layers3,
  LockKeyhole,
  Radio,
  RefreshCw,
  ShieldCheck,
  Undo2,
  Waves,
  type LucideIcon,
} from 'lucide-react';
import { perSecondToAnnual } from '@mezodot/sdk';
import { ChainLogo, TokenLogo } from '../components/Logos';
import { LoopDiagram, prdLoopPlan } from '../components/LoopDiagram';
import { Brand } from '../components/ui';
import { HUB, SPOKES } from '../chain/env';
import { computeTvl, useAgent, useLoopStats, usePrices, useProtocol } from '../data/hooks';
import type { View } from '../hooks/useHashRoute';
import { AgentConsole } from '../landing/AgentConsole';
import { HeroNetwork } from '../landing/HeroNetwork';
import { prefersReducedMotion, useCountUp, useInView, useScrolled } from '../landing/motion';
import { YieldSpark } from '../landing/YieldSpark';
import { compactUsd, fmt, fmtApy, pct, units } from '../lib/format';
import { useUi } from '../state/UiContext';
import '../landing/landing.css';

const SECTIONS = [
  ['product', 'Product'],
  ['how', 'How it works'],
  ['security', 'Security'],
] as const;

/** Scrolls to a section without touching the hash, which the router owns. */
const jumpTo = (id: string) => (e: MouseEvent) => {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
};

/** Fades its content up the first time it scrolls into view. */
function Reveal({ children, className = '', delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const [ref, seen] = useInView<HTMLDivElement>();
  return (
    <div ref={ref} className={`reveal${seen ? ' is-visible' : ''} ${className}`} style={{ '--reveal-delay': `${delay}ms` } as CSSProperties}>
      {children}
    </div>
  );
}

export function Landing() {
  const { go } = useUi();
  const launch = () => go('dashboard');
  // Mobile browsers tint their toolbar with theme-color: dark to match the hero here, the app's paper elsewhere.
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;
    const previous = meta.content;
    meta.content = '#121327';
    return () => {
      meta.content = previous;
    };
  }, []);
  return (
    <div className="landing">
      <LandingNav onLaunch={launch} />
      <main>
        <Hero onLaunch={launch} />
        <LiveStats />
        <Product />
        <HowItWorks />
        <Security onArchitecture={() => go('architecture')} />
        <Closing onLaunch={launch} />
      </main>
      <LandingFooter go={go} />
    </div>
  );
}

function LandingNav({ onLaunch }: { onLaunch: () => void }) {
  const scrolled = useScrolled();
  return (
    <header className={`lp-nav${scrolled ? ' is-scrolled' : ''}`}>
      <div className="lp-container lp-nav-inner">
        <a
          href="#/"
          className="lp-brand"
          aria-label="Mezodot home"
          onClick={(e) => {
            e.preventDefault();
            window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
          }}
        >
          <Brand />
        </a>
        <nav className="lp-links" aria-label="Page sections">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} onClick={jumpTo(id)}>
              {label}
            </a>
          ))}
        </nav>
        <button className="lp-button lp-button--primary lp-launch" onClick={onLaunch}>
          Launch app <ArrowUpRight size={15} />
        </button>
      </div>
    </header>
  );
}

function Hero({ onLaunch }: { onLaunch: () => void }) {
  return (
    <section className="lp-hero">
      <div className="lp-hero-backdrop" aria-hidden="true" />
      <div className="lp-container lp-hero-grid">
        <div className="lp-hero-copy">
          <span className="lp-pill">
            <i /> Live on {HUB.label} · {SPOKES.length} spoke chains
          </span>
          <h1>
            Capital, <em>in motion.</em>
          </h1>
          <p className="lp-lead">
            An omnichain money market on Mezo. Earn ERC-4626 yield on MUSD and MEZO, borrow against BTC on Mezo or WETH and USDC that never leave Base or
            Ethereum, and go long BTC up to 3× in a single transaction.
          </p>
          <div className="lp-cta-row">
            <button className="lp-button lp-button--primary" onClick={onLaunch}>
              Launch app <ArrowRight size={16} />
            </button>
            <a className="lp-button lp-button--ghost" href="#how" onClick={jumpTo('how')}>
              How it works
            </a>
          </div>
          <ul className="lp-proof">
            <li>
              <Waves size={14} /> Wormhole guardian-signed messages
            </li>
            <li>
              <Radio size={14} /> Pyth and Supra prices
            </li>
            <li>
              <Coins size={14} /> ERC-4626 vault shares
            </li>
          </ul>
        </div>
        <div className="lp-hero-visual">
          <HeroNetwork />
          {(['WETH', 'USDC', 'MUSD', 'MEZO'] as const).map((s) => (
            <span key={s} className={`lp-chip lp-chip--${s.toLowerCase()}`} aria-hidden="true">
              <TokenLogo symbol={s} size={22} /> {s}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

type Stats = { crossChainBorrowRatio: number | null; borrowers: number };

function LiveStats() {
  const protocol = useProtocol().data;
  const prices = usePrices().data;
  const loops = useLoopStats().data;
  const stats = useAgent<Stats>('/stats').data;
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  const tvl = useCountUp(protocol && prices ? computeTvl(protocol, prices.prices) : null, seen);
  const volume = useCountUp(loops ? units(loops.volume, 18) : null, seen);
  const ratio = useCountUp(stats?.crossChainBorrowRatio ?? null, seen);
  const chains = useCountUp(1 + SPOKES.length, seen, 900);
  const items = [
    { label: 'Total value locked', value: tvl === null ? '—' : compactUsd(tvl), foot: 'Hub pools and spoke collateral' },
    { label: 'Looping volume', value: volume === null ? '—' : compactUsd(volume), foot: `${loops?.loops ?? 0} one-transaction loops` },
    { label: 'Debt backed cross-chain', value: ratio === null ? '—' : pct(ratio), foot: 'Borrowed against Base and Ethereum collateral' },
    {
      label: 'Chains, one market',
      value: chains === null ? '—' : fmt(Math.round(chains)),
      foot: [HUB, ...SPOKES].map((n) => n.label.split(' ')[0]).join(' · '),
    },
  ];
  return (
    <section className="lp-stats" aria-label="Live protocol figures">
      <div ref={ref} className="lp-container">
        <div className="lp-stats-head">
          <span className="lp-live">
            <i /> LIVE ON {HUB.label.toUpperCase()}
          </span>
          {protocol && <span>block {fmt(Number(protocol.blockNumber))}</span>}
        </div>
        <div className="lp-stats-grid">
          {items.map((s, i) => (
            <Reveal key={s.label} className="lp-stat" delay={i * 90}>
              <span>{s.label}</span>
              <strong>{s.value}</strong>
              <small>{s.foot}</small>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function SectionHead({ eyebrow, title, accent, body }: { eyebrow: string; title: string; accent: string; body: string }) {
  return (
    <Reveal className="lp-section-head">
      <span className="lp-eyebrow">{eyebrow}</span>
      <h2>
        {title} <em>{accent}</em>
      </h2>
      <p>{body}</p>
    </Reveal>
  );
}

function FeatureCopy({ icon: Icon, kicker, title, body }: { icon: LucideIcon; kicker: string; title: string; body: string }) {
  return (
    <div className="lp-feature-copy">
      <span className="lp-kicker">
        <Icon size={14} /> {kicker}
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

/** Spokes on the left, the hub on the right, messages running between them. */
function RouteStrip() {
  return (
    <div className="route-strip" aria-hidden="true">
      <div className="route-end">
        <span className="route-logos">
          <ChainLogo network="base-sepolia" size={34} />
          <ChainLogo network="eth-sepolia" size={34} />
        </span>
        <small>lock on a spoke</small>
      </div>
      <div className="route-wire">
        <span className="route-label">VAA · 13/19 guardians</span>
        <i />
        <i />
        <i />
      </div>
      <div className="route-end">
        <ChainLogo network="mezo-testnet" size={40} />
        <small>credit on Mezo</small>
      </div>
    </div>
  );
}

function Product() {
  const protocol = useProtocol().data;
  const musd = protocol?.markets.find((m) => m.symbol === 'MUSD');
  const [consoleRef, consoleSeen] = useInView<HTMLDivElement>();
  return (
    <section id="product" className="lp-section">
      <div className="lp-container">
        <SectionHead
          eyebrow="PRODUCT"
          title="One market. Three chains."
          accent="No bridged principal."
          body="Everything settles on the Mezo Hub. Only guardian-signed messages cross chains, so collateral stays exactly where it was locked."
        />
        <div className="lp-feature-grid">
          <Reveal className="lp-feature lp-feature--wide">
            <FeatureCopy
              icon={GitBranch}
              kicker="CROSS-CHAIN COLLATERAL"
              title="Borrow on Mezo against assets on Base and Ethereum"
              body="Lock WETH or USDC in a SpokeGateway. Wormhole guardians sign the deposit once its block is final, and VaultManager credits it to one health factor on the hub. Repay, and a release message unlocks it at home."
            />
            <RouteStrip />
          </Reveal>
          <Reveal className="lp-feature">
            <FeatureCopy
              icon={Coins}
              kicker="ERC-4626 YIELD"
              title="Shares that grow with every borrow"
              body="Supply MUSD or MEZO and receive pMUSD or pMEZO. Their exchange rate rises as borrower interest accrues, and keeps rising while they are posted as collateral."
            />
            <YieldSpark
              rate={musd ? fmt(units(musd.exchangeRate, musd.decimals), 6) : '1.000000'}
              apy={musd ? fmtApy(perSecondToAnnual(musd.supplyRatePerSecond)) : '—'}
            />
          </Reveal>
          <Reveal className="lp-feature" delay={90}>
            <FeatureCopy
              icon={RefreshCw}
              kicker="ONE-TRANSACTION LEVERAGE"
              title="Long BTC up to 3×, or loop MUSD, in one signature"
              body="A flash loan from the MUSD pool buys BTC on Mezo's Tigris DEX (or adds pMUSD supply), the position is posted, and the borrow repays the loan, all in one call priced with the pool's own fee and collateral terms."
            />
            <div className="lp-feature-visual">
              <LoopDiagram plan={prdLoopPlan(protocol?.collaterals)} />
            </div>
          </Reveal>
          <Reveal className="lp-feature lp-feature--wide">
            <FeatureCopy
              icon={Bot}
              kicker="AGENT-RUN RISK"
              title="Keepers, relayers and oracles that never sleep"
              body="The Mezodot agent relays Wormhole messages, attaches Supra price proofs and liquidates unhealthy positions, and offers the same tools to AI agents over MCP."
            />
            <div ref={consoleRef}>
              <AgentConsole active={consoleSeen} />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

const STEPS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: LockKeyhole, title: 'Lock', body: 'Deposit WETH or USDC into the SpokeGateway on Base or Ethereum.' },
  { icon: Waves, title: 'Sign', body: 'Once the block is final, about 15 to 20 minutes, 13 of 19 Wormhole guardians sign it.' },
  { icon: ShieldCheck, title: 'Credit', body: 'The hub verifies the message and VaultManager credits your collateral on Mezo.' },
  { icon: Coins, title: 'Borrow', body: 'Borrow MUSD or MEZO against one health factor across every chain.' },
  { icon: Undo2, title: 'Release', body: 'Repay, and a release message unlocks your collateral on its own chain.' },
];

function HowItWorks() {
  const [ref, seen] = useInView<HTMLOListElement>(0.35);
  const motion = !prefersReducedMotion();
  const [active, setActive] = useState(motion ? 0 : STEPS.length - 1);
  useEffect(() => {
    if (!seen || !motion) return;
    const id = setInterval(() => setActive((a) => (a + 1) % STEPS.length), 2_400);
    return () => clearInterval(id);
  }, [seen, motion]);
  return (
    <section id="how" className="lp-section lp-section--tint">
      <div className="lp-container">
        <SectionHead
          eyebrow="HOW IT WORKS"
          title="From a spoke chain to MUSD"
          accent="in five steps."
          body="The same path the Cross-chain page walks you through, with a live countdown while the guardians wait for finality."
        />
        <ol ref={ref} className="lp-steps" style={{ '--progress': active / (STEPS.length - 1) } as CSSProperties}>
          {STEPS.map((s, i) => (
            <li key={s.title} className={i <= active ? 'is-done' : ''} aria-current={i === active ? 'step' : undefined}>
              <span className="lp-step-icon">
                <s.icon size={17} />
              </span>
              <b>
                <small>0{i + 1}</small> {s.title}
              </b>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const GUARANTEES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Radio,
    title: 'Two price sources',
    body: 'Pyth, pushed on Mezo, and Supra pull proofs, each with staleness and confidence limits and cross-checked for divergence.',
  },
  {
    icon: Waves,
    title: 'Finalized, single-use messages',
    body: 'Guardians sign only after source-chain finality. Every message is bound to its destination and can be consumed once.',
  },
  {
    icon: Layers3,
    title: 'Losses absorbed in order',
    body: 'Bad debt is written off against protocol reserves first; suppliers carry only what reserves cannot cover.',
  },
  { icon: ShieldCheck, title: 'Exits stay open', body: 'Pausing stops new deposits and borrows. Repaying, withdrawing and closing positions keep working.' },
];

function Security({ onArchitecture }: { onArchitecture: () => void }) {
  return (
    <section id="security" className="lp-section">
      <div className="lp-container">
        <SectionHead
          eyebrow="SECURITY"
          title="Built to fail"
          accent="safely."
          body="Risk is enforced by the contracts on Mezo, not by an operator. The agent only does what anyone else could."
        />
        <div className="lp-guarantees">
          {GUARANTEES.map((g, i) => (
            <Reveal key={g.title} className="lp-guarantee" delay={i * 80}>
              <span className="lp-guarantee-icon">
                <g.icon size={18} />
              </span>
              <b>{g.title}</b>
              <p>{g.body}</p>
            </Reveal>
          ))}
        </div>
        <Reveal className="lp-audit-note">
          <span className="lp-badge">UNAUDITED · TESTNET ONLY</span>
          <p>Mezodot runs on Mezo Testnet, Base Sepolia and Ethereum Sepolia. Use test funds only.</p>
          <button className="lp-text-link" onClick={onArchitecture}>
            Read the architecture <ArrowRight size={14} />
          </button>
        </Reveal>
      </div>
    </section>
  );
}

function Closing({ onLaunch }: { onLaunch: () => void }) {
  return (
    <section className="lp-closing">
      <div className="lp-container lp-closing-inner">
        <Reveal>
          <h2>
            Put idle collateral <em>to work.</em>
          </h2>
          <p>Connect a wallet on Mezo Testnet, Base Sepolia or Ethereum Sepolia and open your first position in minutes.</p>
        </Reveal>
        <button className="lp-button lp-button--primary" onClick={onLaunch}>
          Launch app <ArrowRight size={16} />
        </button>
      </div>
    </section>
  );
}

const APP_LINKS: [View, string][] = [
  ['dashboard', 'Overview'],
  ['markets', 'Markets'],
  ['crosschain', 'Cross-chain'],
  ['borrow', 'Borrow'],
  ['loop', 'Loop'],
];
const PROTOCOL_LINKS: [View, string][] = [
  ['architecture', 'Architecture'],
  ['agents', 'Agents & risk'],
  ['activity', 'Activity'],
];
const ECOSYSTEM: [string, string][] = [
  ['https://mezo.org', 'Mezo'],
  ['https://wormhole.com', 'Wormhole'],
  ['https://pyth.network', 'Pyth'],
  ['https://supra.com', 'Supra'],
];

function LandingFooter({ go }: { go: (view: View) => void }) {
  const appLink = ([view, label]: [View, string]) => (
    <a
      key={view}
      href={`#/${view}`}
      onClick={(e) => {
        e.preventDefault();
        go(view);
      }}
    >
      {label}
    </a>
  );
  return (
    <footer className="lp-footer">
      <div className="lp-container lp-footer-grid">
        <div className="lp-footer-brand">
          <Brand />
          <p>Productive capital, across chains. Built on Mezo.</p>
        </div>
        <nav aria-label="App">
          <b>App</b>
          {APP_LINKS.map(appLink)}
        </nav>
        <nav aria-label="Protocol">
          <b>Protocol</b>
          {PROTOCOL_LINKS.map(appLink)}
        </nav>
        <nav aria-label="Ecosystem">
          <b>Ecosystem</b>
          {ECOSYSTEM.map(([href, label]) => (
            <a key={href} href={href} target="_blank" rel="noreferrer">
              {label} <ArrowUpRight size={12} />
            </a>
          ))}
        </nav>
      </div>
      <div className="lp-container lp-footer-base">
        <span>© 2026 Mezodot</span>
        <span>UNAUDITED · TESTNET ONLY</span>
      </div>
    </footer>
  );
}
