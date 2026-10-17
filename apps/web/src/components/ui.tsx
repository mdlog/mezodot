import type { ReactNode } from 'react';
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  ExternalLink,
  GitBranch,
  LockKeyhole,
  RefreshCw,
  Shield,
  ShieldAlert,
  Undo2,
  Unlock,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import type { NetworkInfo } from '@mezodot/sdk';
import { ENV_NAME, HUB, explorerAddress, explorerTx } from '../chain/env';
import type { ActivityKind } from '../data/activity';

export function Brand() {
  return (
    <div className="brand-lockup">
      <div className="brand-mark">
        <span />
        <span />
        <span />
        <i />
      </div>
      <div>
        <strong>mezodot</strong>
        <small>PROTOCOL / 01</small>
      </div>
    </div>
  );
}

/** Network badge replacing the old "simulated data" tag: data on these pages is live. */
export function NetworkTag() {
  return (
    <span className={`sim-tag network-tag network-tag--${ENV_NAME}`}>
      <i /> {ENV_NAME === 'devnet' ? 'LOCAL DEVNET' : HUB.label.toUpperCase()}
    </span>
  );
}

export function PageTitle({ eyebrow, title, subtitle, right }: { eyebrow: string; title: string; subtitle: string; right?: ReactNode }) {
  return (
    <div className="page-title">
      <div>
        <div className="eyebrow">
          <span>{eyebrow}</span>
          <b>·</b>
          <span>MEZO HUB</span>
        </div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {right && <div className="title-actions">{right}</div>}
    </div>
  );
}

export function PanelTitle({ label, meta, action }: { label: string; meta?: string; action?: ReactNode }) {
  return (
    <div className="panel-title">
      <div>
        <h3>{label}</h3>
        {meta && <span>{meta}</span>}
      </div>
      {action}
    </div>
  );
}

export function SummaryStrip({ snapshot, time, icon: Icon }: { snapshot: ReactNode; time: string; icon: LucideIcon }) {
  return (
    <div className="summary-strip">
      <NetworkTag />
      <span className="snapshot">{snapshot}</span>
      <span className="snapshot-time">
        <Icon size={13} /> {time}
      </span>
    </div>
  );
}

export function StatCard({ label, value, change, icon: Icon, accent = false, foot }: { label: string; value: string; change?: string; icon: LucideIcon; accent?: boolean; foot: string }) {
  return (
    <article className={`stat-card ${accent ? 'stat-card--accent' : ''}`}>
      <div className="stat-top">
        <span>{label}</span>
        <span className="stat-icon">
          <Icon size={15} />
        </span>
      </div>
      <div className="stat-value-row">
        <strong>{value}</strong>
        {change && <span className="positive">{change}</span>}
      </div>
      <div className="stat-foot">
        <span>{foot}</span>
      </div>
    </article>
  );
}

export function InfoBar({ title, children, action, onAction }: { title: string; children: ReactNode; action?: string; onAction?: () => void }) {
  return (
    <div className="disclaimer-bar">
      <Shield size={15} />
      <span>
        <b>{title}</b> {children}
      </span>
      {action && onAction && (
        <button onClick={onAction}>
          {action} <ArrowRight size={13} />
        </button>
      )}
    </div>
  );
}

export function AmountInput({
  id,
  value,
  onChange,
  unit,
  onMax,
  large = false,
  autoFocus = false,
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  unit: string;
  onMax?: () => void;
  large?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={`amount-input ${large ? 'amount-input--large' : ''}`}>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        value={value}
        disabled={disabled}
        data-autofocus={autoFocus || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      <span>{unit}</span>
      {onMax && (
        <button type="button" onClick={onMax} disabled={disabled}>
          MAX
        </button>
      )}
    </div>
  );
}

export function TxLink({ network, hash, label }: { network: NetworkInfo; hash: string; label?: string }) {
  const url = explorerTx(network, hash);
  const text = label ?? `${hash.slice(0, 8)}…${hash.slice(-4)}`;
  if (!url) return <code className="tx-code">{text}</code>;
  return (
    <a className="tx-code tx-link" href={url} target="_blank" rel="noreferrer">
      {text} <ExternalLink size={11} />
    </a>
  );
}

export function AddressLink({ network, address }: { network: NetworkInfo; address: string }) {
  const url = explorerAddress(network, address);
  const text = `${address.slice(0, 6)}…${address.slice(-4)}`;
  if (!url) return <code className="tx-code">{text}</code>;
  return (
    <a className="tx-code tx-link" href={url} target="_blank" rel="noreferrer">
      {text} <ExternalLink size={11} />
    </a>
  );
}

/** Shown in place of data when the hub has not been deployed on this network yet. */
export function NotDeployed() {
  return (
    <div className="panel empty-state empty-state--panel">
      <ShieldAlert size={23} />
      <b>Contracts are not deployed on {HUB.label} yet</b>
      <span>
        Run the deployment in <code>docs/DEPLOY.md</code>, or start the local devnet (<code>scripts/devnet/start.sh</code>) and open the app with{' '}
        <code>VITE_MEZODOT_ENV=devnet</code>.
      </span>
    </div>
  );
}

/** Wraps an action area: prompts for a wallet when disconnected. */
export function ConnectGate({ connected, children, label = 'Connect a wallet to continue' }: { connected: boolean; children: ReactNode; label?: string }) {
  if (connected) return <>{children}</>;
  return (
    <div className="connect-gate">
      <Wallet size={16} />
      <span>{label}</span>
      <ConnectButton.Custom>
        {({ openConnectModal }) => (
          <button className="button button--dark" onClick={openConnectModal}>
            Connect wallet
          </button>
        )}
      </ConnectButton.Custom>
    </div>
  );
}

const EVENT_ICONS: Record<ActivityKind, LucideIcon> = {
  Supply: ArrowDownToLine,
  Withdraw: ArrowUpRight,
  'Collateral in': LockKeyhole,
  'Collateral out': Unlock,
  'Cross-chain': GitBranch,
  Release: GitBranch,
  Borrow: ArrowDownLeft,
  Repay: Undo2,
  Loop: RefreshCw,
  Unwind: Undo2,
  Liquidation: ShieldAlert,
};

export function EventIcon({ kind }: { kind: ActivityKind }) {
  const Icon = EVENT_ICONS[kind];
  return (
    <span className={`event-icon event-${kind.toLowerCase().replace(/[^a-z]/g, '')}`}>
      <Icon size={15} />
    </span>
  );
}

export function Spinner() {
  return <RefreshCw size={13} className="spin" aria-hidden="true" />;
}
