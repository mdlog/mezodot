/**
 * pMUSD's exchange rate only ever rises: borrower interest flows into the pool, so each share redeems for more
 * MUSD over time. The curve is that shape (illustrative); the figures beside it are live.
 */
const CURVE = 'M 4 66 C 50 63, 92 57, 132 47 S 196 22, 236 8';

export function YieldSpark({ rate, apy }: { rate: string; apy: string }) {
  return (
    <div className="yield-spark">
      <svg viewBox="0 0 240 74" aria-hidden="true">
        <defs>
          <linearGradient id="yield-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#4338ca" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#4338ca" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path className="yield-area" d={`${CURVE} L 236 74 L 4 74 Z`} />
        <path className="yield-line" d={CURVE} pathLength={1} />
        <circle className="yield-dot" cx={236} cy={8} r={4} />
      </svg>
      <div className="yield-figures">
        <span>
          <small>1 pMUSD</small>
          <b>{rate} MUSD</b>
        </span>
        <span>
          <small>supply APY now</small>
          <b>{apy}</b>
        </span>
      </div>
    </div>
  );
}
