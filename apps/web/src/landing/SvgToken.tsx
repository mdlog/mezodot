import { TokenLogo } from '../components/Logos';

/**
 * A token logo inside an SVG drawing, centred on the current origin. Some logos are HTML images (MUSD), which SVG
 * does not render, so every one sits in a foreignObject.
 */
export function SvgToken({ symbol, size }: { symbol: string; size: number }) {
  return (
    <foreignObject x={-size / 2} y={-size / 2} width={size} height={size} className="svg-token">
      <TokenLogo symbol={symbol} size={size} />
    </foreignObject>
  );
}
