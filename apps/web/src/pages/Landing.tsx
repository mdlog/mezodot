import { useEffect, type MouseEvent } from 'react';
import { ArrowRight, ArrowUpRight, Layers3, Radio, ShieldCheck, Waves, type LucideIcon } from 'lucide-react';
import { perSecondToApy } from '@mezodot/sdk';
import { Brand } from '../components/ui';
import { useProtocol } from '../data/hooks';
import type { View } from '../hooks/useHashRoute';
import { AgentConsole } from '../landing/AgentConsole';
import { Journey } from '../landing/Journey';
import { OrbitHero } from '../landing/OrbitHero';
import { Simulator } from '../landing/Simulator';
import { prefersReducedMotion, useInView, useScrolled } from '../landing/motion';
import { YieldSpark } from '../landing/YieldSpark';
import { fmt, fmtApy, units } from '../lib/format';
import { useUi } from '../state/UiContext';
import '../landing/landing.css';

const SECTIONS = [
  ['journey', 'How it works'],
  ['simulator', 'Try it'],
  ['features', 'Features'],
  ['security', 'Security'],
] as const;

/** Scrolls to a section without touching the hash, which the router owns. */
const jumpTo = (id: string) => (e: MouseEvent) => {
  e.preventDefault();
  document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
};

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
        <OrbitHero onLaunch={launch} />
        <Journey />
        <Simulator onOpen={() => go('crosschain')} />
        <Features onPortfolio={() => go('portfolio')} />
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

/** A few of the tools the agent's MCP server registers (services/agent/src/mcp/server.ts). */
const MCP_TOOLS = ['get_position', 'get_risk_report', 'simulate_borrow', 'simulate_loop', 'list_liquidatable', 'relay_message'];

function Features({ onPortfolio }: { onPortfolio: () => void }) {
  const protocol = useProtocol().data;
  const musd = protocol?.markets.find((m) => m.symbol === 'MUSD');
  const [consoleRef, consoleSeen] = useInView<HTMLDivElement>();
  const [yieldRef, yieldSeen] = useInView<HTMLDivElement>();
  return (
    <section id="features" className="lp-features" aria-labelledby="lp-features-title">
      <div className="lp-container">
        <header className="lp-section-head">
          <h2 id="lp-features-title">Working while you are not</h2>
          <p>Keepers watch every position, deposits keep earning, and one page shows where everything stands.</p>
        </header>
        <div className="lp-features-grid">
          <article className="lp-feature lp-feature--agent">
            <h3>Agents that never sleep</h3>
            <p>
              The Mezodot agent relays Wormhole messages, attaches Supra price proofs and liquidates unhealthy positions. AI agents get the same tools over MCP.
            </p>
            <div ref={consoleRef}>
              <AgentConsole active={consoleSeen} />
            </div>
            <div className="lp-mcp">
              <p>
                Over MCP, an AI agent can read markets, positions and risk, simulate a borrow or a loop, and find positions to liquidate. Some of its tools:
              </p>
              <ul>
                {MCP_TOOLS.map((t) => (
                  <li key={t}>
                    <code>{t}</code>
                  </li>
                ))}
              </ul>
            </div>
          </article>
          <article className="lp-feature">
            <h3>Yield that stays in the share</h3>
            <p>Supply MUSD or MEZO for pMUSD or pMEZO. The exchange rate rises as borrowers pay interest, and keeps rising while the shares back a loan.</p>
            <div ref={yieldRef} className={yieldSeen ? 'is-visible' : undefined}>
              <YieldSpark
                rate={musd ? fmt(units(musd.exchangeRate, musd.decimals), 6) : '1.000000'}
                apy={musd ? fmtApy(perSecondToApy(musd.supplyRatePerSecond)) : '—'}
              />
            </div>
          </article>
          <article className="lp-feature">
            <h3>Everything you hold, on one page</h3>
            <p>Supplied pTokens, collateral on every chain, debt and health factor, each with the action it allows.</p>
            <button className="lp-text-link" onClick={onPortfolio}>
              Open Portfolio <ArrowRight size={14} />
            </button>
          </article>
        </div>
      </div>
    </section>
  );
}

const GUARANTEES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Radio,
    title: 'Prices with limits',
    body: 'Pyth prices every market on Mezo. ETH, USDC and BTC also carry a Supra pull proof as a second source. Every feed has staleness and confidence limits.',
  },
  {
    icon: Waves,
    title: 'Finalized, single-use messages',
    body: 'Guardians sign only after the source chain finalizes. Every message is bound to its destination and can be used once.',
  },
  {
    icon: Layers3,
    title: 'Losses absorbed in order',
    body: "Bad debt is written off against the pool's reserves first. Suppliers carry only what reserves cannot cover.",
  },
  {
    icon: ShieldCheck,
    title: 'Exits stay open',
    body: 'Pausing stops new supply, borrowing and flash loans. Repaying, withdrawing and liquidations keep working.',
  },
];

function Security({ onArchitecture }: { onArchitecture: () => void }) {
  return (
    <section id="security" className="lp-security" aria-labelledby="lp-security-title">
      <div className="lp-container">
        <header className="lp-section-head">
          <h2 id="lp-security-title">Built to fail safely</h2>
          <p>Risk is enforced by the contracts on Mezo, not by an operator. The agent only does what anyone else could.</p>
        </header>
        <ul className="lp-guarantees">
          {GUARANTEES.map((g) => (
            <li key={g.title}>
              <g.icon size={18} aria-hidden="true" />
              <b>{g.title}</b>
              <p>{g.body}</p>
            </li>
          ))}
        </ul>
        <p className="lp-audit-note">
          <span className="lp-badge">Unaudited, testnet only</span>
          Mezodot runs on Mezo Testnet, Base Sepolia and Ethereum Sepolia. Use test funds only.
          <button className="lp-text-link" onClick={onArchitecture}>
            Read the architecture <ArrowRight size={14} />
          </button>
        </p>
      </div>
    </section>
  );
}

function Closing({ onLaunch }: { onLaunch: () => void }) {
  return (
    <section className="lp-closing">
      <div className="lp-container lp-closing-inner">
        <div>
          <h2>Put idle collateral to work.</h2>
          <p>Connect a wallet on Mezo Testnet, Base Sepolia or Ethereum Sepolia and open a position in minutes.</p>
        </div>
        <button className="lp-button lp-button--primary" onClick={onLaunch}>
          Launch app <ArrowUpRight size={16} />
        </button>
      </div>
    </section>
  );
}

const FOOTER_LINKS: [string, [View, string][]][] = [
  [
    'App',
    [
      ['dashboard', 'Overview'],
      ['markets', 'Markets'],
      ['crosschain', 'Cross-chain'],
      ['borrow', 'Borrow'],
      ['loop', 'Loop'],
    ],
  ],
  [
    'Account',
    [
      ['portfolio', 'Portfolio'],
      ['activity', 'Activity'],
    ],
  ],
  [
    'Protocol',
    [
      ['architecture', 'Architecture'],
      ['agents', 'Agents & risk'],
    ],
  ],
];
const ECOSYSTEM: [string, string][] = [
  ['https://mezo.org', 'Mezo'],
  ['https://wormhole.com', 'Wormhole'],
  ['https://pyth.network', 'Pyth'],
  ['https://supra.com', 'Supra'],
];

function LandingFooter({ go }: { go: (view: View) => void }) {
  return (
    <footer className="lp-footer">
      <div className="lp-container lp-footer-grid">
        <div className="lp-footer-brand">
          <Brand />
          <p>Productive capital, across chains. Built on Mezo.</p>
        </div>
        {FOOTER_LINKS.map(([group, links]) => (
          <nav key={group} aria-label={group}>
            <b>{group}</b>
            {links.map(([view, label]) => (
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
            ))}
          </nav>
        ))}
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
        <span>Unaudited, testnet only</span>
      </div>
    </footer>
  );
}
