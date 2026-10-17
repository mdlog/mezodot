import { healthStatus } from '../lib/protocol';

/** Health bar scaled so 3.0× fills the track; "no debt" renders full. */
export function HealthBar({ hf }: { hf: number }) {
  const width = Number.isFinite(hf) ? Math.min(100, Math.max(6, (hf / 3) * 100)) : 100;
  return (
    <div className={`health-bar tone-${healthStatus(hf).tone}`}>
      <i style={{ width: `${width}%` }} />
    </div>
  );
}
