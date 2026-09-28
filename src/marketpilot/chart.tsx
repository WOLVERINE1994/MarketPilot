import type { Candle } from "./types";
import { displayTime } from "./time";
export function Chart({ bars, timeframe, stop }: { bars: Candle[]; timeframe: number; stop?: number }) {
  const grouped: Candle[] = [];
  for (const b of bars) {
    const bucket = Math.floor(Date.parse(b.time) / (timeframe * 60000)), last = grouped.at(-1);
    if (last && Math.floor(Date.parse(last.time) / (timeframe * 60000)) === bucket) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close; last.volume += b.volume; }
    else grouped.push({ ...b });
  }
  const visible = grouped.slice(-65), values = visible.flatMap(b => [b.low, b.high]);
  if (!visible.length) return <div className="mp-empty-chart"><p>Waiting for verified market data</p><span>No live prices are simulated.</span></div>;
  if (stop) values.push(stop);
  const min = Math.min(...values) - 12, max = Math.max(...values) + 12, y = (v: number) => 255 - (v - min) / (max - min) * 225, spacing = 790 / Math.max(visible.length, 25), last = visible.at(-1)!;
  return <svg viewBox="0 0 900 330" role="img" aria-label={`${timeframe}-minute CRUDEOILM candlestick chart; latest ${last.close} rupees`} className="mp-chart">
    {[0, 1, 2, 3, 4].map(i => { const value = min + (max - min) * i / 4; return <g key={i}><line x1="12" x2="812" y1={y(value)} y2={y(value)} stroke="#243143" strokeDasharray="3 5"/><text x="828" y={y(value) + 4} fill="#8191a8" fontSize="11">{value.toFixed(0)}</text></g>; })}
    {visible.map((b, i) => { const x = 20 + i * spacing, color = b.close >= b.open ? "#3bcba5" : "#f07b87"; return <g key={b.time}><title>{displayTime(b.time)} IST · O {b.open} H {b.high} L {b.low} C {b.close}</title><line x1={x} x2={x} y1={y(b.high)} y2={y(b.low)} stroke={color}/><rect x={x - spacing * 0.29} y={Math.min(y(b.open), y(b.close))} width={spacing * 0.58} height={Math.max(2, Math.abs(y(b.open) - y(b.close)))} fill={color}/><rect x={x - spacing * 0.29} y={294 - Math.min(24, b.volume / 10)} width={spacing * 0.58} height={Math.min(24, b.volume / 10)} fill={color} opacity="0.2"/>{i % Math.max(1, Math.floor(visible.length / 5)) === 0 && <text x={x} y="319" textAnchor="middle" fill="#8191a8" fontSize="10">{new Date(b.time).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false })}</text>}</g>; })}
    <line x1="12" x2="812" y1={y(last.close)} y2={y(last.close)} stroke="#3bcba5" strokeDasharray="4 4" opacity="0.6"/><text x="826" y={y(last.close) + 4} fill="#55dfb7" fontSize="12" fontWeight="bold">{last.close.toFixed(0)}</text>
    {stop && <g><line x1="12" x2="812" y1={y(stop)} y2={y(stop)} stroke="#f07b87" strokeDasharray="6 4"/><text x="18" y={y(stop) - 5} fill="#f07b87" fontSize="10">STOP {stop}</text></g>}
  </svg>;
}
