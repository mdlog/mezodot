import { useEffect, useMemo, useState } from 'react';
import { NETWORKS, type NetworkName } from '@mezodot/sdk';
import { useAgent, usePrices } from '../data/hooks';
import { money, shortAddress } from '../lib/format';
import { prefersReducedMotion } from './motion';

type Line = { module: 'oracle' | 'relayer' | 'keeper'; text: string };
type Message = { direction: string; source: NetworkName; target: NetworkName; status: string };
type Evaluation = { account: string; healthFactor: number };

const VISIBLE = 5;
const STEP_MS = 1_700;
/** What the agent does when it has nothing live to report (agent offline). */
const IDLE: Line[] = [
  { module: 'keeper', text: 'scanning borrower health on every block' },
  { module: 'relayer', text: 'watching SpokeGateway deposits on Base and Ethereum' },
  { module: 'oracle', text: 'attaching Supra proofs before ETH/USDC/BTC borrows' },
  { module: 'keeper', text: 'liquidates 50% below 1.00× and earns the bonus less the protocol share' },
];

const label = (n: NetworkName) => NETWORKS[n]?.label ?? n;

/**
 * A rolling log built from the Mezodot agent's live state: oracle prices, Wormhole messages it relayed and the
 * health of the borrowers it watches. A new line scrolls in every couple of seconds.
 */
export function AgentConsole({ active }: { active: boolean }) {
  const prices = usePrices().data?.prices;
  const messages = useAgent<Message[]>('/messages', 30_000).data;
  const watch = useAgent<Evaluation[]>('/liquidatable', 30_000).data;
  const lines = useMemo(() => {
    const out: Line[] = [];
    if (prices?.ETH) out.push({ module: 'oracle', text: `ETH/USD ${money(prices.ETH, 2)} · Supra pull proof` });
    for (const m of (messages ?? []).slice(0, 3)) out.push({ module: 'relayer', text: `${m.direction} ${label(m.source)} → ${label(m.target)} · ${m.status}` });
    if (prices?.MUSD) out.push({ module: 'oracle', text: `MUSD/USD ${money(prices.MUSD, 4)} · Pyth push on Mezo` });
    for (const e of (watch ?? []).slice(0, 2))
      out.push({
        module: 'keeper',
        text: `${shortAddress(e.account)} HF ${e.healthFactor.toFixed(2)}× · ${e.healthFactor < 1 ? 'liquidating 50%' : 'watching'}`,
      });
    return out.length >= VISIBLE ? out : [...out, ...IDLE];
  }, [prices, messages, watch]);

  const motion = !prefersReducedMotion();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active || !motion) return;
    const id = setInterval(() => setTick((t) => t + 1), STEP_MS);
    return () => clearInterval(id);
  }, [active, motion]);

  // Absolute indices key the rows, so only the newest one animates in.
  const rows = Array.from({ length: VISIBLE }, (_, i) => tick + i);
  return (
    <div className="agent-console" aria-label="Mezodot agent log">
      <div className="agent-console-bar">
        <i />
        <i />
        <i />
        <span>mezodot-agent · testnet</span>
      </div>
      <ol>
        {rows.map((n) => {
          const line = lines[n % lines.length];
          return (
            <li key={n}>
              <b className={`agent-module agent-module--${line.module}`}>{line.module}</b>
              <span>{line.text}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
