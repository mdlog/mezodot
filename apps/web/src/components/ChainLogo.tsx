import type { NetworkName } from '@mezodot/sdk';

/** Base's network mark (brand kit): a blue disc with the horizontal notch. */
function BaseMark({ size }: { size: number }) {
  return (
    <svg className="chain-logo" width={size} height={size} viewBox="0 0 111 111" role="img" aria-label="Base">
      <path
        fill="#0052FF"
        d="M54.921 110.034C85.359 110.034 110.034 85.402 110.034 55.017C110.034 24.6319 85.359 0 54.921 0C26.0432 0 2.35281 22.1714 0 50.3923H72.8467V59.6416H0C2.35281 87.8625 26.0432 110.034 54.921 110.034Z"
      />
    </svg>
  );
}

/** Ether's diamond on its usual #627EEA disc (cryptocurrency-icons, CC0). */
function EthereumMark({ size }: { size: number }) {
  return (
    <svg className="chain-logo" width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Ethereum">
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
}

/** Logo of a spoke network; other networks fall back to an initial on a disc. */
export function ChainLogo({ network, label, size = 26 }: { network: NetworkName; label: string; size?: number }) {
  // The local devnet spoke stands in for Base.
  if (network === 'base-sepolia' || network === 'devnet-spoke') return <BaseMark size={size} />;
  if (network === 'eth-sepolia') return <EthereumMark size={size} />;
  return (
    <span className="chain-disc" style={{ width: size, height: size }}>
      {label[0]}
    </span>
  );
}
