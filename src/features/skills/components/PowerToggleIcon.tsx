type PowerToggleIconProps = {
  isSpinning?: boolean;
};

export function PowerToggleIcon({ isSpinning = false }: PowerToggleIconProps) {
  return (
    <svg
      className={isSpinning ? "skill-card__power-icon is-spinning" : "skill-card__power-icon"}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M10 3.5v6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M6.35 6.85a5.25 5.25 0 1 0 7.3 0"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
