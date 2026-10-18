import { ChainLogo } from '../components/Logos';
import { prefersReducedMotion } from './motion';

/*
 * The hero animation is the protocol's own message flow: a deposit on a spoke chain becomes a Wormhole
 * message (VAA), waits at the guardians until a quorum has signed, then lands on the Mezo Hub, which
 * credits the collateral. Each spoke sends one every lap, half a lap apart.
 */

const LAP = 6; // seconds per message
// Spoke centres, hub centre and radii (viewBox 520 × 440).
const SPOKES = [
  { network: 'base-sepolia', label: 'Base Sepolia', x: 86, y: 118, begin: 0 },
  { network: 'eth-sepolia', label: 'Ethereum Sepolia', x: 86, y: 322, begin: LAP / 2 },
] as const;
const HUB = { x: 420, y: 220, r: 56 };
const SPOKE_R = 34;
// Ring visual only: the guardian set and its quorum are Wormhole's, not something this page reads.
const GUARDIANS = 19;
const QUORUM = 13;
// Share of the lap: travel to the guardians, wait while they sign, travel on to the hub.
const ARRIVE_GUARDIANS = 0.32;
const LEAVE_GUARDIANS = 0.68;

/** Symmetric cubic from a spoke's edge to the hub's edge, so its arc-length midpoint is its geometric one. */
function route(s: (typeof SPOKES)[number]) {
  const endY = s.y < HUB.y ? HUB.y - 16 : HUB.y + 16;
  const p0 = [s.x + SPOKE_R, s.y];
  const p3 = [HUB.x - HUB.r, endY];
  const p1 = [p0[0] + 100, p0[1]];
  const p2 = [p3[0] - 100, p3[1]];
  return { d: `M ${p0} C ${p1} ${p2} ${p3}`, mid: [(p0[0] + p3[0]) / 2, (p0[1] + p3[1]) / 2] as const };
}

export function HeroNetwork() {
  const motion = !prefersReducedMotion();
  return (
    <svg
      className="hero-net"
      viewBox="0 0 520 440"
      role="img"
      aria-label="Deposits on Base and Ethereum travel as Wormhole messages, signed by a quorum of guardians, to the Mezo Hub"
    >
      <defs>
        <radialGradient id="hub-glow">
          <stop offset="0%" stopColor="#6d63f0" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#6d63f0" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={HUB.x} cy={HUB.y} r={120} fill="url(#hub-glow)" />

      {SPOKES.map((s) => {
        const { d, mid } = route(s);
        return (
          <g key={s.network}>
            <path className="net-track" d={d} />
            {/* Guardian ring halfway: signers light up while the message waits for the quorum. */}
            <g transform={`translate(${mid[0]} ${mid[1]})`}>
              <circle className="net-ring" r={21} />
              {Array.from({ length: GUARDIANS }, (_, i) => {
                const a = (2 * Math.PI * i) / GUARDIANS - Math.PI / 2;
                const signsAt = ARRIVE_GUARDIANS + 0.02 + (i * 0.28) / QUORUM;
                return (
                  <circle
                    key={i}
                    className={`net-guardian${i < QUORUM ? ' is-signer' : ''}`}
                    cx={21 * Math.cos(a)}
                    cy={21 * Math.sin(a)}
                    r={2.4}
                    opacity={motion || i >= QUORUM ? 0.25 : 1}
                  >
                    {motion && i < QUORUM && (
                      <animate
                        attributeName="opacity"
                        dur={`${LAP}s`}
                        begin={`${s.begin}s`}
                        repeatCount="indefinite"
                        calcMode="discrete"
                        keyTimes={`0;${signsAt.toFixed(3)};0.8`}
                        values="0.25;1;0.25"
                      />
                    )}
                  </circle>
                );
              })}
              <text className="net-quorum" y={36} textAnchor="middle" opacity={motion ? 0 : 1}>
                quorum signed
                {motion && (
                  <animate
                    attributeName="opacity"
                    dur={`${LAP}s`}
                    begin={`${s.begin}s`}
                    repeatCount="indefinite"
                    calcMode="discrete"
                    keyTimes="0;0.62;0.8"
                    values="0;1;0"
                  />
                )}
              </text>
            </g>
            {motion && (
              <>
                {/* The deposit leaving its spoke. */}
                <circle className="net-ripple" cx={s.x} cy={s.y} r={SPOKE_R}>
                  <animate
                    attributeName="r"
                    dur={`${LAP}s`}
                    begin={`${s.begin}s`}
                    repeatCount="indefinite"
                    keyTimes="0;0.16;1"
                    values={`${SPOKE_R};${SPOKE_R + 16};${SPOKE_R + 16}`}
                  />
                  <animate attributeName="opacity" dur={`${LAP}s`} begin={`${s.begin}s`} repeatCount="indefinite" keyTimes="0;0.16;1" values="0.5;0;0" />
                </circle>
                <g className="net-packet" opacity={0}>
                  <rect x={-16} y={-8.5} width={32} height={17} rx={5} />
                  <text y={3} textAnchor="middle">
                    VAA
                  </text>
                  <animateMotion
                    dur={`${LAP}s`}
                    begin={`${s.begin}s`}
                    repeatCount="indefinite"
                    calcMode="linear"
                    path={d}
                    keyTimes={`0;${ARRIVE_GUARDIANS};${LEAVE_GUARDIANS};1`}
                    keyPoints="0;0.5;0.5;1"
                  />
                  <animate attributeName="opacity" dur={`${LAP}s`} begin={`${s.begin}s`} repeatCount="indefinite" keyTimes="0;0.04;0.95;1" values="0;1;1;0" />
                </g>
                {/* The hub credits the collateral as the message lands. */}
                <circle className="net-ripple net-ripple--hub" cx={HUB.x} cy={HUB.y} r={HUB.r} opacity={0}>
                  <animate
                    attributeName="r"
                    dur={`${LAP}s`}
                    begin={`${s.begin + LAP * 0.95}s`}
                    repeatCount="indefinite"
                    keyTimes="0;0.22;1"
                    values={`${HUB.r};${HUB.r + 34};${HUB.r + 34}`}
                  />
                  <animate
                    attributeName="opacity"
                    dur={`${LAP}s`}
                    begin={`${s.begin + LAP * 0.95}s`}
                    repeatCount="indefinite"
                    keyTimes="0;0.22;1"
                    values="0.6;0;0"
                  />
                </circle>
              </>
            )}
            <circle className="net-node" cx={s.x} cy={s.y} r={SPOKE_R} />
            <g transform={`translate(${s.x - 20} ${s.y - 20})`}>
              <ChainLogo network={s.network} size={40} />
            </g>
            <text className="net-label" x={s.x} y={s.y + SPOKE_R + 20} textAnchor="middle">
              {s.label}
            </text>
            <text className="net-sublabel" x={s.x} y={s.y + SPOKE_R + 34} textAnchor="middle">
              locks WETH · USDC
            </text>
          </g>
        );
      })}

      <text className="net-caption" x={242} y={224} textAnchor="middle">
        WORMHOLE GUARDIANS
      </text>

      <circle className="net-node net-node--hub" cx={HUB.x} cy={HUB.y} r={HUB.r} />
      <g transform={`translate(${HUB.x - 30} ${HUB.y - 30})`}>
        <ChainLogo network="mezo-testnet" size={60} />
      </g>
      <text className="net-label" x={HUB.x} y={HUB.y + HUB.r + 22} textAnchor="middle">
        Mezo Hub
      </text>
      <text className="net-sublabel" x={HUB.x} y={HUB.y + HUB.r + 36} textAnchor="middle">
        credits collateral · lends MUSD
      </text>
    </svg>
  );
}
