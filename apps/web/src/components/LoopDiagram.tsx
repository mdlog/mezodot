import type { LoopPlan } from '@mezodot/sdk';
import { fmt, fmtHealth } from '../lib/format';

/*
 * The atomic flash-loan loop as a route: one lap of the ring is the single LeverageManager transaction.
 * Step 1 flash-borrows MUSD, step 2 supplies equity + flash as pMUSD collateral, step 3 borrows MUSD against
 * it and repays the flash loan. A packet travels the ring, resting on each step while it runs.
 */

// Geometry in viewBox units (250 × 182): ring centre and radius, step node radius.
const CX = 125;
const CY = 94;
const R = 52;
const NODE = 10;

/** Point on the ring `fraction` of a lap clockwise from the top. */
const ringPoint = (fraction: number): [number, number] => {
  const angle = 2 * Math.PI * fraction - Math.PI / 2;
  return [CX + R * Math.cos(angle), CY + R * Math.sin(angle)];
};

const LAP_SECONDS = 7.5;
/** Steps sit a third of a lap apart; the packet rests a tenth of the lap on each, then moves on. */
const STEPS = [0, 1 / 3, 2 / 3];
const ROUTE = `M ${CX} ${CY - R} A ${R} ${R} 0 0 1 ${CX} ${CY + R} A ${R} ${R} 0 0 1 ${CX} ${CY - R}`;
const MOTION = { keyTimes: '0;0.1;0.333;0.433;0.667;0.767;1', keyPoints: '0;0;0.3333;0.3333;0.6667;0.6667;1' };
/** Each step glows while the packet rests on it. */
const GLOW = [
  { keyTimes: '0;0.1', values: '1;0' },
  { keyTimes: '0;0.333;0.433', values: '0;1;0' },
  { keyTimes: '0;0.667;0.767', values: '0;1;0' },
];

const amount = (n: number) => fmt(n, Number.isInteger(n) ? 0 : 1);

export function LoopDiagram({ plan }: { plan: LoopPlan }) {
  const [, [x2, y2], [x3, y3]] = STEPS.map((s) => ringPoint(s));
  // Labels sit outside the ring: step 1 above it, steps 2 and 3 under their nodes, growing outwards.
  const labels = [
    { x: CX, y: CY - R - NODE - 18, anchor: 'middle', caption: 'flash loan', value: `${amount(plan.flashAmount)} MUSD` },
    { x: x2 - 8, y: y2 + NODE + 15, anchor: 'start', caption: 'supply as pMUSD', value: `${amount(plan.gross)} MUSD` },
    { x: x3 + 8, y: y3 + NODE + 15, anchor: 'end', caption: 'borrow → repay', value: `${amount(plan.debt)} MUSD` },
  ] as const;
  return (
    <svg
      className="loop-diagram"
      viewBox="0 0 250 182"
      role="img"
      aria-label={`Flash-loan loop in one transaction: ${amount(plan.principal)} MUSD equity, flash loan ${amount(plan.flashAmount)}, supply ${amount(plan.gross)}, borrow ${amount(plan.debt)} to repay it; ${plan.leverage}× exposure, health factor ${fmtHealth(plan.healthFactor)}`}
    >
      <circle className="loop-track" cx={CX} cy={CY} r={R} />
      {STEPS.map((s) => {
        // Direction of travel, halfway to the next step.
        const [x, y] = ringPoint(s + 1 / 6);
        return <path key={s} className="loop-arrow" d="M -3 -3.5 L 1.5 0 L -3 3.5" transform={`translate(${x} ${y}) rotate(${(s + 1 / 6) * 360})`} />;
      })}
      {/* Under the steps: while it rests on one, the node glows instead. */}
      <circle className="loop-packet" r={4}>
        <animateMotion dur={`${LAP_SECONDS}s`} repeatCount="indefinite" calcMode="linear" path={ROUTE} {...MOTION} />
      </circle>
      {STEPS.map((s, i) => {
        const [x, y] = ringPoint(s);
        return (
          <g key={s}>
            <circle className="loop-glow" cx={x} cy={y} r={NODE + 5} opacity={i === 0 ? 1 : 0}>
              <animate attributeName="opacity" dur={`${LAP_SECONDS}s`} repeatCount="indefinite" calcMode="discrete" {...GLOW[i]} />
            </circle>
            <circle className="loop-step" cx={x} cy={y} r={NODE} />
            <text className="loop-step-number" x={x} y={y + 3.5} textAnchor="middle">
              {i + 1}
            </text>
          </g>
        );
      })}

      {labels.map((l) => (
        <g key={l.caption}>
          <text className="loop-caption" x={l.x} y={l.y} textAnchor={l.anchor}>
            {l.caption}
          </text>
          <text className="loop-amount" x={l.x} y={l.y + 12} textAnchor={l.anchor}>
            {l.value}
          </text>
        </g>
      ))}

      <text className="loop-exposure" x={CX} y={CY + 5} textAnchor="middle">
        {plan.leverage}×
      </text>
      <text className="loop-caption" x={CX} y={CY + 18} textAnchor="middle">
        EXPOSURE
      </text>
      <text className="loop-health" x={CX} y={CY + 30} textAnchor="middle">
        HF {fmtHealth(plan.healthFactor)}
      </text>

      {/* What goes in, and what the account holds once the transaction lands. */}
      <text className="loop-amount" x={4} y={50}>
        ${amount(plan.principal)}
      </text>
      <text className="loop-caption" x={4} y={62}>
        equity
      </text>
      <text className="loop-amount" x={246} y={50} textAnchor="end">
        ${amount(plan.gross)}
      </text>
      <text className="loop-caption" x={246} y={62} textAnchor="end">
        position
      </text>
      <text className="loop-caption loop-caption--route" x={CX} y={178} textAnchor="middle">
        FLASH ROUTE · 1 TX
      </text>
    </svg>
  );
}
