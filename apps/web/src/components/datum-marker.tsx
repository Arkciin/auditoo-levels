import { cn } from "@/lib/utils";

/**
 * The level datum marker of building section drawings: an inverted triangle, half filled, whose
 * apex sits on the floor line. Relevé uses it as the signature of every level.
 */
export function DatumMarker({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 12"
      aria-hidden="true"
      className={cn("h-3 w-4 shrink-0 text-foreground", className)}
    >
      <path d="M1 1h14L8 11.2z" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M1 1h7v10.2z" fill="currentColor" />
    </svg>
  );
}
