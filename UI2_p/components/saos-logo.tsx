"use client";

export function SaosLogo({
  size = 32,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`}
      aria-label="SAOS Brutalist Cyber Logo"
    >
      {/* Outer Hex/Cube Brutalist Frame */}
      <rect
        x="3"
        y="3"
        width="42"
        height="42"
        fill="#071922"
        stroke="#5edc56"
        strokeWidth="3"
      />

      {/* Cyber Grid Corner Accents */}
      <rect x="7" y="7" width="3" height="3" fill="#5edc56" />
      <rect x="38" y="7" width="3" height="3" fill="#5edc56" />
      <rect x="7" y="38" width="3" height="3" fill="#5edc56" />
      <rect x="38" y="38" width="3" height="3" fill="#5edc56" />

      {/* High-Voltage Interlocking 'S' & Twin Nodes */}
      <path
        d="M34 14H18C15.7909 14 14 15.7909 14 18V21C14 23.2091 15.7909 25 18 25H30C32.2091 25 34 26.7909 34 29V32C34 34.2091 32.2091 36 30 36H14"
        stroke="#5edc56"
        strokeWidth="3.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />

      {/* Central Quantum Node Pulse */}
      <circle cx="24" cy="25" r="3.5" fill="#5edc56" />
      <circle cx="24" cy="25" r="1.5" fill="#071922" />

      {/* Digital Circuit Horizontal Ticks */}
      <line x1="14" y1="18" x2="11" y2="18" stroke="#5edc56" strokeWidth="2" />
      <line x1="34" y1="32" x2="37" y2="32" stroke="#5edc56" strokeWidth="2" />
    </svg>
  );
}
