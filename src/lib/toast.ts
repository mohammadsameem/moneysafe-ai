/** The rules behind the toaster. Pure, so they are unit-tested without a browser. */

export type ToastTone = "success" | "error" | "info";

export interface ToastInput {
  tone?: ToastTone;
  title: string;
  description?: string;
}

export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

/** At most this many toasts are on screen; the oldest is dropped first. */
export const MAX_TOASTS = 4;

/** How long a toast stays: errors longer, because they matter more and take longer to read. */
export function toastDurationMs(tone: ToastTone): number {
  return tone === "error" ? 8_000 : 5_000;
}

/** The list after adding one toast (newest last). */
export function addToast(list: readonly ToastItem[], input: ToastInput, id: number): ToastItem[] {
  const item: ToastItem = { id, tone: input.tone ?? "info", title: input.title, ...(input.description ? { description: input.description } : {}) };
  return [...list, item].slice(-MAX_TOASTS);
}

export const removeToast = (list: readonly ToastItem[], id: number): ToastItem[] => list.filter((t) => t.id !== id);
