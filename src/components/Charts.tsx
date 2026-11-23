// Dependency-free SVG charts (server-rendered, accessible via <title>/<desc> and a data table fallback).

export function LineChart({ title, points, format }: { title: string; points: { x: string; y: number | null }[]; format: (n: number) => string }) {
  const vals = points.map((p) => p.y).filter((v): v is number => v !== null);
  if (vals.length === 0) return null;
  const W = 640, H = 200, P = { l: 56, r: 12, t: 12, b: 28 };
  const max = Math.max(...vals) || 1;
  const x = (i: number) => P.l + (points.length === 1 ? (W - P.l - P.r) / 2 : (i * (W - P.l - P.r)) / (points.length - 1));
  const y = (v: number) => H - P.b - (v / max) * (H - P.t - P.b);
  let d = "";
  points.forEach((p, i) => {
    if (p.y === null) return;
    d += `${d === "" || points[i - 1]?.y === null ? "M" : "L"}${x(i).toFixed(1)},${y(p.y).toFixed(1)} `;
  });
  const ticks = [0, 0.5, 1].map((f) => max * f);
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  return (
    <figure className="rounded-xl border border-gray-200 bg-white p-4">
      <figcaption className="mb-2 text-sm font-medium text-gray-800">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title}: line chart with ${points.length} days`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="#e5e7eb" />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#6b7280">{format(t)}</text>
          </g>
        ))}
        <path d={d} fill="none" stroke="#2459bd" strokeWidth="2" />
        {points.map((p, i) => (p.y !== null && points.length <= 45 ? <circle key={p.x} cx={x(i)} cy={y(p.y)} r="2.5" fill="#2459bd"><title>{`${p.x}: ${format(p.y)}`}</title></circle> : null))}
        {points.map((p, i) => (i % labelEvery === 0 ? <text key={p.x} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="#6b7280">{p.x.slice(5)}</text> : null))}
      </svg>
    </figure>
  );
}

export function BarList({ title, items, format }: { title: string; items: { label: string; value: number; note?: string }[]; format: (n: number) => string }) {
  if (items.length === 0) return null;
  const max = Math.max(...items.map((i) => i.value)) || 1;
  return (
    <figure className="rounded-xl border border-gray-200 bg-white p-4">
      <figcaption className="mb-3 text-sm font-medium text-gray-800">{title}</figcaption>
      <ul className="space-y-2">
        {items.map((i) => (
          <li key={i.label}>
            <div className="flex justify-between text-xs text-gray-700"><span>{i.label}{i.note ? ` · ${i.note}` : ""}</span><span className="font-medium">{format(i.value)}</span></div>
            <div className="mt-1 h-2 rounded bg-gray-100"><div className="h-2 rounded bg-brand-500" style={{ width: `${(i.value / max) * 100}%` }} /></div>
          </li>
        ))}
      </ul>
    </figure>
  );
}
