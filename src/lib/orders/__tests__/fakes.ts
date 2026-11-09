import { vi, type Mock } from "vitest";
import type { NewOrder, Order } from "@/db/schema";
import type { ActivityMeta } from "@/lib/activity/logger";
import type { PayPalClient } from "@/lib/paypal";
import { DEFAULT_SIGNAL_WEIGHTS } from "@/lib/scoring";
import type { OrderDeps, OrdersRepo } from "../types";

export const WEIGHTS_ID = "00000000-0000-4000-8000-0000000000a1";
export const SESSION = "session-a";
export const OTHER_SESSION = "session-b";
export const BASE_URL = "https://moneysafe.test";

const NOW = "2026-11-08T10:00:00.000Z";

/** A complete order row with safe defaults; override what a test cares about. */
export function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    paypalOrderId: "PAYPAL-ORDER-1",
    paypalCaptureId: null,
    buyerEmail: "pending@paypal.invalid",
    buyerIsFirstTime: true,
    paymentAttemptCount: 1,
    shippingMethod: "standard",
    billingCountry: "US",
    shippingCountry: "US",
    amountUsd: 50,
    currency: "USD",
    status: "created",
    riskScore: null,
    verdict: null,
    aiExplanation: null,
    usedFallback: false,
    verificationDraft: null,
    evidenceCompleteness: null,
    signalBreakdown: null,
    weightsId: null,
    sessionId: SESSION,
    isSeed: false,
    isDemo: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export interface FakeRepo extends OrdersRepo {
  rows: Map<string, Order>;
  /** Make the next transitionStatus call lose the race (as if another request had already moved the order). */
  loseNextTransition(): void;
  failWeightsLookup(): void;
}

/** In-memory OrdersRepo. Mirrors the SQL semantics the service relies on. */
export function createFakeRepo(initial: Order[] = [], baselineAvgUsd = 85): FakeRepo {
  const rows = new Map(initial.map((o) => [o.id, o]));
  let loseNext = false;
  let weightsBroken = false;

  const save = (id: string, patch: Partial<NewOrder>): Order => {
    const current = rows.get(id);
    if (!current) throw new Error("order to update does not exist");
    const next = { ...current, ...patch, updatedAt: NOW } as Order;
    rows.set(id, next);
    return next;
  };

  return {
    rows,
    loseNextTransition: () => {
      loseNext = true;
    },
    failWeightsLookup: () => {
      weightsBroken = true;
    },
    getBaselineAvgUsd: async () => baselineAvgUsd,
    getActiveWeights: async () => {
      if (weightsBroken) throw new Error("connection lost");
      return { id: WEIGHTS_ID, values: { ...DEFAULT_SIGNAL_WEIGHTS } };
    },
    hasEarlierPaidOrder: async (email, excludeId) =>
      Array.from(rows.values()).some(
        (o) =>
          o.id !== excludeId &&
          o.buyerEmail.toLowerCase() === email.trim().toLowerCase() &&
          (o.status === "captured" || o.status === "shipped"),
      ),
    insertOrder: async (row) => {
      const full = makeOrder({ ...(row as Partial<Order>), id: row.id ?? crypto.randomUUID() });
      rows.set(full.id, full);
      return full;
    },
    findById: async (id) => rows.get(id) ?? null,
    findByPayPalOrderId: async (paypalOrderId) =>
      Array.from(rows.values()).find((o) => o.paypalOrderId === paypalOrderId) ?? null,
    updateOrder: async (id, patch) => save(id, patch),
    transitionStatus: async (id, from, patch) => {
      if (loseNext) {
        loseNext = false;
        // The "other request" got there first and captured the order.
        save(id, { status: "captured", paypalCaptureId: "CAPTURE-FROM-OTHER-REQUEST" });
        return null;
      }
      const current = rows.get(id);
      return current && current.status === from ? save(id, patch) : null;
    },
  };
}

/** A PayPalClient whose `request` is also a vitest mock (calls are inspectable). */
export type FakePayPal = PayPalClient & { request: PayPalClient["request"] & Mock };

/**
 * A PayPalClient whose responses are keyed by "METHOD path-suffix". The real zod schemas still
 * run, so a response the app could not parse fails here too.
 */
export function createFakePayPal(responses: Record<string, unknown | Error>): FakePayPal {
  const request = vi.fn(async (path: string, init: { method: string }, schema: { parse(v: unknown): unknown }) => {
    const key = Object.keys(responses).find((k) => {
      const [method, suffix] = k.split(" ");
      return method === init.method && path.endsWith(suffix ?? "");
    });
    if (!key) throw new Error(`unexpected PayPal call: ${init.method} ${path}`);
    const value = responses[key];
    if (value instanceof Error) throw value;
    return schema.parse(value);
  });
  return { request } as unknown as FakePayPal;
}

export const CREATE_RESPONSE = {
  id: "PAYPAL-ORDER-1",
  status: "PAYER_ACTION_REQUIRED",
  links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL-ORDER-1", rel: "payer-action" }],
};

export function captureResponse(overrides: { status?: string; email?: string | null } = {}) {
  return {
    id: "PAYPAL-ORDER-1",
    status: overrides.status ?? "COMPLETED",
    purchase_units: [{ payments: { captures: [{ id: "CAPTURE-1", status: "COMPLETED" }] } }],
    payer: overrides.email === null ? {} : { email_address: overrides.email ?? "buyer@example.com" },
  };
}

/**
 * A fake activity logger. Like the real agent_activity table it has a foreign key to orders, so it
 * fails if a step is logged for an order that does not exist yet.
 */
export function createLogRecorder(repo: FakeRepo): { log: NonNullable<OrderDeps["log"]>; entries: ActivityMeta[] } {
  const entries: ActivityMeta[] = [];
  return {
    entries,
    log: async (meta) => {
      if (meta.refOrderId && !repo.rows.has(meta.refOrderId)) {
        throw new Error(`foreign key violation: order ${meta.refOrderId} does not exist yet`);
      }
      entries.push(meta);
    },
  };
}

export function makeDeps(overrides: Partial<OrderDeps> = {}): OrderDeps {
  return {
    repo: createFakeRepo(),
    paypal: null,
    demoMode: false,
    appBaseUrl: BASE_URL,
    newId: () => "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}
