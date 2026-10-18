import { useState } from 'react';
import {
  Activity as ActivityIcon,
  ArrowDownLeft,
  BarChart3,
  ChevronRight,
  CircleHelp,
  ExternalLink,
  LayoutDashboard,
  Menu,
  Network,
  Radio,
  RefreshCw,
  Route,
  X,
  type LucideIcon,
} from 'lucide-react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ActionModal } from './components/ActionModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Modal } from './components/Modal';
import { ChainLogo } from './components/Logos';
import { BalancesBanner, ConfigErrorScreen, HubStatusBanner, RelayBanner } from './components/StatusBanners';
import { ToastView, TxProgress } from './components/TxFeedback';
import { Brand } from './components/ui';
import { CONFIG_ERRORS, ENV_NAME, HUB, HUB_DEPLOYED, SPOKES } from './chain/env';
import type { View } from './hooks/useHashRoute';
import { Activity } from './pages/Activity';
import { Agents } from './pages/Agents';
import { Architecture } from './pages/Architecture';
import { Borrow } from './pages/Borrow';
import { Crosschain } from './pages/Crosschain';
import { Dashboard } from './pages/Dashboard';
import { Loop } from './pages/Loop';
import { Landing } from './pages/Landing';
import { Markets } from './pages/Markets';
import { TxProvider } from './state/TxContext';
import { UiProvider, useUi } from './state/UiContext';

type NavItem = { key: View; label: string; icon: LucideIcon; group: 'PROTOCOL' | 'CAPITAL' | 'INTELLIGENCE' };

const NAV_ITEMS: NavItem[] = [
  { key: 'dashboard', label: 'Overview', icon: LayoutDashboard, group: 'PROTOCOL' },
  { key: 'markets', label: 'Markets', icon: BarChart3, group: 'PROTOCOL' },
  { key: 'crosschain', label: 'Cross-chain', icon: Route, group: 'CAPITAL' },
  { key: 'borrow', label: 'Borrow', icon: ArrowDownLeft, group: 'CAPITAL' },
  { key: 'loop', label: 'Loop', icon: RefreshCw, group: 'CAPITAL' },
  { key: 'agents', label: 'Agents & risk', icon: Radio, group: 'INTELLIGENCE' },
  { key: 'architecture', label: 'Architecture', icon: Network, group: 'INTELLIGENCE' },
  { key: 'activity', label: 'Activity', icon: ActivityIcon, group: 'INTELLIGENCE' },
];
const NAV_GROUPS = ['PROTOCOL', 'CAPITAL', 'INTELLIGENCE'] as const;

/** App views; the landing page renders on its own, outside the app shell. */
const PAGES: Record<Exclude<View, 'landing'>, () => JSX.Element> = {
  dashboard: Dashboard,
  markets: Markets,
  crosschain: Crosschain,
  borrow: Borrow,
  loop: Loop,
  agents: Agents,
  architecture: Architecture,
  activity: Activity,
};

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { view, go } = useUi();
  return (
    <aside className={`sidebar ${open ? 'sidebar--open' : ''}`}>
      <div className="sidebar-brand">
        <a
          href="#/"
          className="brand-home"
          aria-label="Mezodot home"
          onClick={(e) => {
            e.preventDefault();
            go('landing');
          }}
        >
          <Brand />
        </a>
        <button className="mobile-close icon-button" onClick={onClose} aria-label="Close navigation">
          <X size={17} />
        </button>
      </div>
      <nav className="side-nav" aria-label="Main navigation">
        {NAV_GROUPS.map((group) => (
          <div className="nav-group" key={group}>
            <span className="nav-group-label">{group}</span>
            {NAV_ITEMS.filter((item) => item.group === group).map(({ key, label, icon: Icon }) => (
              <a
                key={key}
                href={`#/${key}`}
                className={`nav-link ${view === key ? 'nav-link--active' : ''}`}
                aria-current={view === key ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  go(key);
                  onClose();
                }}
              >
                <Icon size={16} />
                <span>{label}</span>
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <a className="help-link" href="https://github.com/mezo-org" target="_blank" rel="noreferrer">
          <CircleHelp size={15} /> Mezo developer docs <ExternalLink size={12} />
        </a>
        <div className="sidebar-network">
          <div>
            <ChainLogo network={HUB.name} size={23} />
            <span>
              <b>{HUB.label}</b>
              <small>
                <i className={HUB_DEPLOYED ? '' : 'dot-off'} />{' '}
                {HUB_DEPLOYED ? `Hub live · ${SPOKES.length} spoke${SPOKES.length === 1 ? '' : 's'}` : 'Not deployed yet'}
              </small>
            </span>
          </div>
        </div>
        <div className="sidebar-footer">
          <span>MEZODOT</span>
          <span>
            v1.0 <i>·</i> {ENV_NAME.toUpperCase()}
          </span>
        </div>
      </div>
    </aside>
  );
}

function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { view } = useUi();
  const label = NAV_ITEMS.find((item) => item.key === view)?.label ?? 'Overview';
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="mobile-menu-button icon-button" onClick={onOpenMenu} aria-label="Open navigation">
          <Menu size={18} />
        </button>
        <div className="breadcrumb">
          <span>MEZODOT</span>
          <ChevronRight size={13} />
          <b>{label.toUpperCase()}</b>
        </div>
      </div>
      <div className="topbar-right">
        <ConnectButton chainStatus="icon" accountStatus="address" showBalance={false} />
      </div>
    </header>
  );
}

function Shell() {
  const { view, go, modal, closeModal } = useUi();
  const [mobileMenu, setMobileMenu] = useState(false);
  if (view === 'landing') {
    return (
      <ErrorBoundary key="landing" onReset={() => go('dashboard')} resetLabel="Open the app">
        <Landing />
      </ErrorBoundary>
    );
  }
  const Page = PAGES[view];

  return (
    <div className="app-shell">
      <Sidebar open={mobileMenu} onClose={() => setMobileMenu(false)} />
      {mobileMenu && <button className="mobile-scrim" onClick={() => setMobileMenu(false)} aria-label="Close navigation overlay" />}
      <main className="main-shell">
        <Topbar onOpenMenu={() => setMobileMenu(true)} />
        <div className="content-area">
          <div className="page-container">
            <HubStatusBanner />
            <BalancesBanner />
            <RelayBanner />
            <ErrorBoundary key={view} onReset={() => go('dashboard')}>
              <Page />
            </ErrorBoundary>
            <footer className="page-footer">
              <Brand />
              <span>Productive capital, across chains. Built on Mezo.</span>
              <div>
                <span>UNAUDITED</span>
                <span>TESTNET ONLY</span>
                <span>© 2026 MEZODOT</span>
              </div>
            </footer>
          </div>
        </div>
      </main>
      <ErrorBoundary
        key={modal ? JSON.stringify(modal) : 'no-modal'}
        fallback={(error) => (
          <Modal id="action-modal-error" overline="MEZODOT / MEZO HUB" title="Something went wrong" onClose={closeModal}>
            <p className="inline-error" role="alert">
              This dialog hit an unexpected error: {error.message.split('\n')[0]}
            </p>
          </Modal>
        )}
      >
        <ActionModal />
      </ErrorBoundary>
      <div className="toast-stack">
        <TxProgress />
        <ToastView />
      </div>
    </div>
  );
}

export default function App() {
  if (CONFIG_ERRORS.length > 0) return <ConfigErrorScreen />;
  // Views and the dialog have their own boundaries; this one keeps a crash in the shell itself from blanking the page.
  return (
    <ErrorBoundary scope="Mezodot">
      <UiProvider>
        <TxProvider>
          <Shell />
        </TxProvider>
      </UiProvider>
    </ErrorBoundary>
  );
}
