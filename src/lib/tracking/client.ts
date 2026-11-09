/**
 * Carrier tracking (M3-01, REQ-EV-01).
 *
 * `getTrackingEvents` asks the configured provider and validates the answer with zod. Whenever a
 * real provider is unavailable (none configured, DEMO_MODE, an error, or an answer that fails
 * validation) it returns the mocked events, each labelled `isMocked: true`. It never throws for a
 * provider problem, so a tracking outage can never block marking an order shipped.
 */
import { mockedProvider } from "./mocked";
import { TrackingResultSchema, type TrackingProvider, type TrackingQuery, type TrackingResult } from "./types";

export interface TrackingDeps {
  /** A real provider, if one is configured. The app ships with none (see CHANGES.md). */
  provider?: TrackingProvider | null;
  demoMode?: boolean;
  now?: () => Date;
}

export type TrackingFallbackReason = "no_provider" | "demo_mode" | "provider_error" | "invalid_response";

export interface TrackingOutcome {
  result: TrackingResult;
  /** Set when the mocked events were used instead of a real provider. */
  fallback?: TrackingFallbackReason;
}

export async function getTrackingEvents(query: TrackingQuery, deps: TrackingDeps = {}): Promise<TrackingOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const mocked = async (fallback: TrackingFallbackReason): Promise<TrackingOutcome> => ({
    result: TrackingResultSchema.parse({ events: await mockedProvider.getEvents(query, now), provider: mockedProvider.name, isMocked: true }),
    fallback,
  });

  if (deps.demoMode) return mocked("demo_mode");
  const provider = deps.provider;
  if (!provider) return mocked("no_provider");

  let events: unknown;
  try {
    events = await provider.getEvents(query, now);
  } catch {
    return mocked("provider_error");
  }
  const parsed = TrackingResultSchema.safeParse({ events, provider: provider.name, isMocked: false });
  if (!parsed.success) return mocked("invalid_response");
  return { result: parsed.data };
}
