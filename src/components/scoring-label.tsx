import { SCORING_LABEL } from "@/lib/format";

/**
 * REQ-NFR-01: wherever a risk score or a weight appears, say what it is. The score comes from
 * explainable rules; the AI explains it and does not set it.
 */
export function ScoringLabel({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs text-muted-foreground ${className}`.trim()}>
      <span className="font-medium">{SCORING_LABEL}</span>
      <span className="sr-only">. The score is the sum of the weights of the rule-based signals that fired; AI writes the explanation and does not set the score.</span>
    </p>
  );
}
