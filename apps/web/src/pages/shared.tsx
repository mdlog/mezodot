import { healthStatus } from '@mezodot/sdk';
import { HEALTH_BANDS, gaugePoint, healthPosition, ltvBands } from '../lib/health';
import { pct } from '../lib/format';

const at = (position: number) => `${position * 100}%`;

/** Health factor on the shared scale: liquidation (1.0×) at the left end, 3.0× and "no debt" at the right. */
export function HealthBar({ hf }: { hf: number }) {
  const tone = healthStatus(hf).tone;
  return (
    <div className="scale-track" aria-hidden="true">
      <div className="scale-bands">
        {HEALTH_BANDS.map((b) => (
          <span
            key={b.tone}
            className={`scale-band tone-${b.tone}${b.tone === tone ? ' is-active' : ''}`}
            style={{ left: at(healthPosition(b.from)), width: at(healthPosition(b.to) - healthPosition(b.from)) }}
          />
        ))}
      </div>
      <i className={`scale-marker tone-${tone}`} style={{ left: at(healthPosition(hf)) }} />
    </div>
  );
}

// Gauge geometry in viewBox units: pivot, arc radius, and the gap left between bands (fraction of the arc).
const CX = 60;
const CY = 58;
const R = 48;
const GAP = 0.008;

const arc = (from: number, to: number): string => {
  const [x0, y0] = gaugePoint(from, R);
  const [x1, y1] = gaugePoint(to, R);
  return `M ${CX + x0} ${CY + y0} A ${R} ${R} 0 0 1 ${CX + x1} ${CY + y1}`;
};

/** Semicircle gauge of the health factor on the shared scale, needle at the current factor. */
export function HealthGauge({ hf }: { hf: number }) {
  const tone = healthStatus(hf).tone;
  const [nx, ny] = gaugePoint(healthPosition(hf), R - 10);
  const last = HEALTH_BANDS.length - 1;
  return (
    <svg className="health-gauge" viewBox="0 0 120 72" aria-hidden="true">
      {HEALTH_BANDS.map((b, i) => (
        <path
          key={b.tone}
          className={`gauge-band tone-${b.tone}${b.tone === tone ? ' is-active' : ''}`}
          d={arc(healthPosition(b.from) + (i > 0 ? GAP : 0), healthPosition(b.to) - (i < last ? GAP : 0))}
        />
      ))}
      <line className="gauge-needle" x1={CX} y1={CY} x2={CX + nx} y2={CY + ny} />
      <circle className="gauge-pivot" cx={CX} cy={CY} r={4} />
      <text className="gauge-tick" x={CX - R} y={CY + 13} textAnchor="middle">
        1.0×
      </text>
      <text className="gauge-tick" x={CX + R} y={CY + 13} textAnchor="middle">
        3.0×
      </text>
    </svg>
  );
}

/**
 * LTV from 0% to 100%, coloured with the health bands projected onto LTV (so the colour under the marker
 * always matches the status label), with the max-borrow and liquidation lines labelled where they are.
 */
export function LtvMeter({ ltv, maxLtv, liqLtv, hf }: { ltv: number; maxLtv: number; liqLtv: number; hf: number }) {
  const tone = healthStatus(hf).tone;
  return (
    <div className="ltv-meter">
      <span className="ltv-label ltv-label--above" style={{ right: at(1 - liqLtv) }}>
        liquidation {pct(liqLtv, 0)}
      </span>
      <div className="scale-track" aria-hidden="true">
        <div className="scale-bands">
          {ltvBands(liqLtv).map((b) => (
            <span
              key={b.tone}
              className={`scale-band tone-${b.tone}${b.tone === tone ? ' is-active' : ''}`}
              style={{ left: at(b.from), width: at(b.to - b.from) }}
            />
          ))}
          <span className="scale-band scale-band--liquidation" style={{ left: at(liqLtv), width: at(1 - liqLtv) }} />
        </div>
        <span className="scale-tick" style={{ left: at(maxLtv) }} />
        <span className="scale-tick scale-tick--liquidation" style={{ left: at(liqLtv) }} />
        <i className={`scale-marker tone-${tone}`} style={{ left: at(Math.min(1, Math.max(0, ltv))) }} />
      </div>
      <span className="ltv-label" style={{ left: 0 }}>
        0%
      </span>
      <span className="ltv-label" style={{ right: at(1 - maxLtv) }}>
        max borrow {pct(maxLtv, 0)}
      </span>
    </div>
  );
}
