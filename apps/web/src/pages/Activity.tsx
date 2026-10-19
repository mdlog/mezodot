import { useMemo, useState } from 'react';
import { Activity as ActivityIcon, ArrowDownToLine, Clock3, Filter } from 'lucide-react';
import { useAccount } from 'wagmi';
import { HubPending } from '../components/StatusBanners';
import { ConnectGate, EventIcon, PageTitle, PanelTitle, SummaryStrip, TxLink } from '../components/ui';
import { HUB, networkByName } from '../chain/env';
import { useActivity, type ActivityItem, type ActivityKind } from '../data/activity';
import { readError, useHubStatus } from '../data/hooks';
import { fmt, timeAgo, units } from '../lib/format';
import { useUi } from '../state/UiContext';

const KINDS: ('All activity' | ActivityKind)[] = [
  'All activity',
  'Supply',
  'Withdraw',
  'Collateral in',
  'Collateral out',
  'Cross-chain',
  'Release',
  'Borrow',
  'Repay',
  'Loop',
  'Unwind',
  'Liquidation',
];
const networkOf = (item: ActivityItem) => networkByName(item.network) ?? HUB;

export function Activity() {
  const { isConnected } = useAccount();
  const { showToast } = useUi();
  const query = useActivity();
  const hub = useHubStatus();
  // History waits on the hub read: while that fails there is nothing to scan, which is not "no events".
  const waitingOnHub = !query.data && (hub.error !== null || hub.loading);
  const data = useMemo(() => query.data?.items ?? [], [query.data]);
  const spokeErrors = query.data?.spokeErrors ?? [];
  const { isLoading } = query;
  const [filter, setFilter] = useState<(typeof KINDS)[number]>('All activity');
  const filtered = useMemo(() => data.filter((i) => filter === 'All activity' || i.kind === filter), [data, filter]);

  const exportCsv = () => {
    const header = ['time', 'kind', 'network', 'asset', 'amount', 'detail', 'tx'];
    const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = filtered.map((a) =>
      [a.timestamp ? new Date(a.timestamp).toISOString() : '', a.kind, a.network, a.asset, units(a.amount, a.decimals), a.detail, a.txHash].map(esc).join(','),
    );
    const url = URL.createObjectURL(new Blob([[header.join(','), ...rows].join('\n')], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mezodot-activity.csv';
    link.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${filtered.length} records`);
  };

  return (
    <>
      <PageTitle
        eyebrow="INTELLIGENCE"
        title="Every move, accounted for."
        subtitle="Your on-chain history across the Mezo Hub and spoke chains, read directly from contract events."
        right={
          <button className="button button--outline" onClick={exportCsv} disabled={filtered.length === 0}>
            <ArrowDownToLine size={14} /> Export CSV
          </button>
        }
      />
      <SummaryStrip
        snapshot={
          <>
            EVENT LEDGER <i>/</i> {data.length} RECORDS
          </>
        }
        time="Contract events"
        icon={Clock3}
      />
      <ConnectGate connected={isConnected} label="Connect a wallet to load your on-chain activity">
        <section className="panel activity-ledger">
          <div className="ledger-toolbar">
            <PanelTitle label="Your activity" meta="Newest first" />
            <div className="filter-controls">
              <span>
                <Filter size={13} />
              </span>
              <select aria-label="Filter activity" value={filter} onChange={(e) => setFilter(e.target.value as (typeof KINDS)[number])}>
                {KINDS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="table-wrap">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>EVENT</th>
                  <th>AMOUNT</th>
                  <th>NETWORK</th>
                  <th>WHEN</th>
                  <th>TRANSACTION</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="event-cell">
                        <EventIcon kind={item.kind} />
                        <span>
                          <b>{item.kind}</b>
                          <small>{item.detail}</small>
                        </span>
                      </div>
                    </td>
                    <td>
                      <b>
                        {fmt(units(item.amount, item.decimals), 4)} {item.asset}
                      </b>
                    </td>
                    <td>{networkOf(item).label}</td>
                    <td>{item.timestamp ? timeAgo(item.timestamp) : '—'}</td>
                    <td>
                      <TxLink network={networkOf(item)} hash={item.txHash} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {waitingOnHub && <HubPending what="your history" />}
          {query.isError && (
            <div className="inline-error" role="alert">
              Could not read your history from {HUB.label}: {readError(query.error)}.{' '}
              <button className="text-link" onClick={() => void query.refetch()}>
                Retry
              </button>
            </div>
          )}
          {spokeErrors.length > 0 && <p className="muted-note">Spoke history unavailable: {spokeErrors.join('; ')}. Hub records above are complete.</p>}
          {!isLoading && !waitingOnHub && !query.isError && filtered.length === 0 && (
            <div className="empty-state">
              <ActivityIcon size={23} />
              <b>No events{filter === 'All activity' ? ' yet' : ' in this filter'}</b>
              <span>Supply, borrow or post collateral to see your history here.</span>
            </div>
          )}
          {isLoading && <p className="muted-note">Reading events…</p>}
        </section>
      </ConnectGate>
    </>
  );
}
