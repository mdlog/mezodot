import { Check, Shield } from 'lucide-react';
import { fmt, money, timeAgo } from '../lib/format';
import { useApp } from '../state/AppContext';
import { Modal } from './Modal';
import { EventIcon, StatusBadge, assetDigits } from './ui';

export function ActivityDetailModal() {
  const { selectedActivity: item, setSelectedActivity } = useApp();
  if (!item) return null;
  const close = () => setSelectedActivity(null);

  return (
    <Modal
      id="activity-detail"
      overline={`ACTIVITY / ${item.id.toUpperCase()}`}
      title={`${item.kind} details`}
      onClose={close}
      className="activity-detail-modal"
    >
      <div className="detail-status-row">
        <EventIcon kind={item.kind} />
        <div>
          <b>
            {fmt(item.amount, assetDigits(item.asset))} {item.asset}
          </b>
          <small>
            {money(item.value, 2)} · {timeAgo(item.at)}
          </small>
        </div>
        <StatusBadge status={item.status} />
      </div>
      <p className="detail-copy">{item.detail}</p>
      <div className="bridge-review">
        <span>
          Source <b>{item.source}</b>
        </span>
        <span>
          Destination <b>{item.destination}</b>
        </span>
        <span>
          Reference{' '}
          <b>
            <code>{item.tx}</code>
          </b>
        </span>
        <span>
          Record type <b>Simulated demo event</b>
        </span>
      </div>
      <div className="message-warning">
        <Shield size={14} /> This record is a frontend mock and is not verifiable on a block explorer.
      </div>
      <button className="button button--outline button--wide" onClick={close} data-autofocus>
        Close details <Check size={14} />
      </button>
    </Modal>
  );
}
