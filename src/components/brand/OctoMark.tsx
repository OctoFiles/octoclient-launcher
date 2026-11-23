/**
 * OctoClient mark: a rounded octopus head with curling tentacles.
 * Drawn as SVG so it inherits the current colour and stays sharp at any size.
 */
export function OctoMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d="M5.4 10.6a6.6 6.6 0 1 1 13.2 0v1.1a2 2 0 0 1-2 2H7.4a2 2 0 0 1-2-2z"
        fill="currentColor"
        stroke="none"
        opacity="0.9"
      />
      <circle cx="9.1" cy="10.3" r="1.15" fill="#04121a" stroke="none" />
      <circle cx="14.9" cy="10.3" r="1.15" fill="#04121a" stroke="none" />
      <path d="M7.6 14.2c-.7 2-.3 4.1 1.2 5.1M10.9 14.4c-.2 2.2.3 4 1.4 5" />
      <path d="M13.9 14.4c.3 2 .8 3.5 2 4.4M16.8 13.8c1 1.6 1.4 3.4 1.1 5.1" />
      <path d="M5.2 13.9c-1.1 1.3-1.7 2.9-1.7 4.6" />
    </svg>
  );
}
