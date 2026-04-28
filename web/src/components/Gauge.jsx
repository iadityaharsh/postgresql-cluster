import React from 'react';

export default function Gauge({ percent, label, detail, size = 90 }) {
  const p = Math.min(100, Math.max(0, parseFloat(percent) || 0));
  const r = (size - 10) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (p / 100) * circ;
  const color = p > 80 ? '#e74c3c' : p > 60 ? '#f0ad4e' : '#50c878';
  return (
    <div className="gauge-container">
      <svg className="gauge-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--gauge-track)" strokeWidth="6" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="6"
          strokeDasharray={circ} strokeDashoffset={offset}
          strokeLinecap="round" transform={`rotate(-90 ${size/2} ${size/2})`}
          style={{ transition: 'stroke-dashoffset 0.5s' }} />
        <text x={size/2} y={size/2 - 2} textAnchor="middle" fill="var(--text-bright)" fontSize="16" fontWeight="700">{p.toFixed(0)}%</text>
        <text x={size/2} y={size/2 + 14} textAnchor="middle" fill="var(--text-dim)" fontSize="9">{detail || ''}</text>
      </svg>
      <div className="gauge-label">{label}</div>
    </div>
  );
}
