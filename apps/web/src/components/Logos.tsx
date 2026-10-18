import type { ReactElement } from 'react';
import { Coins } from 'lucide-react';
import type { NetworkName } from '@mezodot/sdk';
import musdLogo from '../assets/musd.png';

/*
 * Chain and token logos, drawn from each project's own artwork. They are decorative: every place that
 * shows one also names the chain or token in text.
 */

type Mark = (props: { size: number }) => ReactElement;

/** Base's network mark (brand kit): a blue disc with the horizontal notch. */
const BaseMark: Mark = ({ size }) => (
  <svg className="logo-mark" width={size} height={size} viewBox="0 0 111 111" aria-hidden="true">
    <path
      fill="#0052FF"
      d="M54.921 110.034C85.359 110.034 110.034 85.402 110.034 55.017C110.034 24.6319 85.359 0 54.921 0C26.0432 0 2.35281 22.1714 0 50.3923H72.8467V59.6416H0C2.35281 87.8625 26.0432 110.034 54.921 110.034Z"
    />
  </svg>
);

/** Ether's diamond on its usual #627EEA disc (cryptocurrency-icons, CC0). Also stands for WETH. */
const EthereumMark: Mark = ({ size }) => (
  <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <circle cx="16" cy="16" r="16" fill="#627EEA" />
    <g fill="#FFF">
      <path fillOpacity=".602" d="M16.498 4v8.87l7.497 3.35z" />
      <path d="M16.498 4L9 16.22l7.498-3.35z" />
      <path fillOpacity=".602" d="M16.498 21.968v6.027L24 17.616z" />
      <path d="M16.498 27.995v-6.028L9 17.616z" />
      <path fillOpacity=".2" d="M16.498 20.573l7.497-4.353-7.497-3.348z" />
      <path fillOpacity=".602" d="M9 16.22l7.498 4.353v-7.701z" />
    </g>
  </svg>
);

/**
 * Mezo's circle logo, which is also the MEZO token's: the wave mark (Mezo-Mark-Red.svg, mezo-org/documentation)
 * in white on the #FF004D disc. The viewBox centres a 370-unit disc on the mark so it spans 87% of the
 * diameter, as in the official artwork.
 */
const MezoMark: Mark = ({ size }) => (
  <svg className="logo-mark" width={size} height={size} viewBox="15 -74.5 370 370" aria-hidden="true">
    <circle cx="200" cy="110.5" r="185" fill="#FF004D" />
    <path
      fill="#FFF"
      d="M114.94 142.08L146.44 110.58V110.44L177.79 141.94C186.85 151 197.93 155.03 208.86 155.03C231.73 155.03 253.73 137.2 253.73 110.44L285.08 141.94C294.14 151 305.22 155.03 316.15 155.03C339.02 155.03 361.02 137.2 361.02 110.44H334.12L302.77 79.09C293.71 70.03 282.49 66 271.56 66C248.69 66 226.83 83.69 226.83 110.44L195.48 79.09C186.42 70.03 175.2 66 164.27 66C141.4 66 119.54 83.69 119.54 110.44L39 110.58C39 137.48 61.29 154.88 84.16 154.88C95.09 154.88 106.17 150.85 114.94 142.08Z"
    />
  </svg>
);

/** Mezo's MUSD artwork. Mezo publishes no vector of it, so this is the raster (128 px). */
const MusdMark: Mark = ({ size }) => <img className="logo-mark" src={musdLogo} width={size} height={size} alt="" draggable={false} />;

/** USDC (cryptocurrency-icons, CC0) in Circle's brand blue. */
const UsdcMark: Mark = ({ size }) => (
  <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <circle cx="16" cy="16" r="16" fill="#2775CA" />
    <g fill="#FFF">
      <path d="M20.022 18.124c0-2.124-1.28-2.852-3.84-3.156-1.828-.243-2.193-.728-2.193-1.578 0-.85.61-1.396 1.828-1.396 1.097 0 1.707.364 2.011 1.275a.458.458 0 00.427.303h.975a.416.416 0 00.427-.425v-.06a3.04 3.04 0 00-2.743-2.489V9.142c0-.243-.183-.425-.487-.486h-.915c-.243 0-.426.182-.487.486v1.396c-1.829.242-2.986 1.456-2.986 2.974 0 2.002 1.218 2.791 3.778 3.095 1.707.303 2.255.668 2.255 1.639 0 .97-.853 1.638-2.011 1.638-1.585 0-2.133-.667-2.316-1.578-.06-.242-.244-.364-.427-.364h-1.036a.416.416 0 00-.426.425v.06c.243 1.518 1.219 2.61 3.23 2.914v1.457c0 .242.183.425.487.485h.915c.243 0 .426-.182.487-.485V21.34c1.829-.303 3.047-1.578 3.047-3.217z" />
      <path d="M12.892 24.497c-4.754-1.7-7.192-6.98-5.424-11.653.914-2.55 2.925-4.491 5.424-5.402.244-.121.365-.303.365-.607v-.85c0-.242-.121-.424-.365-.485-.061 0-.183 0-.244.06a10.895 10.895 0 00-7.13 13.717c1.096 3.4 3.717 6.01 7.13 7.102.244.121.488 0 .548-.243.061-.06.061-.122.061-.243v-.85c0-.182-.182-.424-.365-.546zm6.46-18.936c-.244-.122-.488 0-.548.242-.061.061-.061.122-.061.243v.85c0 .243.182.485.365.607 4.754 1.7 7.192 6.98 5.424 11.653-.914 2.55-2.925 4.491-5.424 5.402-.244.121-.365.303-.365.607v.85c0 .242.121.424.365.485.061 0 .183 0 .244-.06a10.895 10.895 0 007.13-13.717c-1.096-3.46-3.778-6.07-7.13-7.162z" />
    </g>
  </svg>
);

/** Mezodot's own mark (public/mezodot-mark.svg), used as the badge on its receipt tokens. */
const MezodotMark: Mark = ({ size }) => (
  <svg className="logo-mark" width={size} height={size} viewBox="0 0 256 256" aria-hidden="true">
    <rect width="256" height="256" rx="58" fill="#4338CA" />
    <path fill="#F8F7F2" d="M54 169V83h21l53 57 53-57h21v86h-27v-49l-47 50-47-50v49H54Z" />
    <circle cx="196" cy="58" r="16" fill="#C9F27C" />
    <path d="M196 78v27M178 58h-24" stroke="#C9F27C" strokeWidth="5" strokeLinecap="round" />
  </svg>
);

/** A token the app has no artwork for. */
const UnknownMark: Mark = ({ size }) => (
  <span className="logo-mark logo-unknown" style={{ width: size, height: size }} aria-hidden="true">
    <Coins size={Math.round(size * 0.6)} />
  </span>
);

/** The local devnet stands in for Mezo (hub) and Base (spoke). */
const CHAIN_MARKS: Record<NetworkName, Mark> = {
  'mezo-testnet': MezoMark,
  'devnet-hub': MezoMark,
  'base-sepolia': BaseMark,
  'devnet-spoke': BaseMark,
  'eth-sepolia': EthereumMark,
};

const TOKEN_MARKS: Partial<Record<string, Mark>> = { MUSD: MusdMark, MEZO: MezoMark, WETH: EthereumMark, USDC: UsdcMark };

export function ChainLogo({ network, size = 26 }: { network: NetworkName; size?: number }) {
  const Logo = CHAIN_MARKS[network];
  return <Logo size={size} />;
}

/** Several chains as overlapping logos, e.g. every spoke at once. */
export function ChainLogoStack({ networks, size = 26 }: { networks: NetworkName[]; size?: number }) {
  return (
    <span className="logo-stack">
      {networks.map((n) => (
        <ChainLogo key={n} network={n} size={size} />
      ))}
    </span>
  );
}

/**
 * Logo of a token. A Mezodot receipt token (pMUSD, pMEZO) shows its underlying asset with the Mezodot badge;
 * pass `network` to badge an asset held on a spoke chain with that chain's logo (skipped when it would repeat
 * the token's own logo, as for WETH on Ethereum).
 */
export function TokenLogo({ symbol, network, size = 24 }: { symbol: string; network?: NetworkName; size?: number }) {
  const underlying = symbol.startsWith('p') ? TOKEN_MARKS[symbol.slice(1)] : undefined;
  const Logo = underlying ?? TOKEN_MARKS[symbol] ?? UnknownMark;
  const chain = network && CHAIN_MARKS[network] !== Logo ? network : undefined;
  const badgeSize = Math.max(8, Math.round(size * 0.5));
  const badge = underlying ? <MezodotMark size={badgeSize} /> : chain ? <ChainLogo network={chain} size={badgeSize} /> : null;
  if (!badge) return <Logo size={size} />;
  return (
    <span className="token-logo">
      <Logo size={size} />
      <span className={underlying ? 'logo-badge logo-badge--square' : 'logo-badge'}>{badge}</span>
    </span>
  );
}
