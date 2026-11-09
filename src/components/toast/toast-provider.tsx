"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { addToast, removeToast, toastDurationMs, type ToastInput, type ToastItem, type ToastTone } from "@/lib/toast";

interface ToastApi {
  toast: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const STYLE: Record<ToastTone, string> = {
  success: "border-green-300 bg-green-50 text-green-950",
  error: "border-red-300 bg-red-50 text-red-950",
  info: "border-sky-300 bg-sky-50 text-sky-950",
};

/**
 * Toast feedback for actions (approval submitted, write error, reset complete, analysis started).
 * Errors use role="alert" and stay longer; everything else is a polite status. Each toast can be
 * dismissed with the button, and none of them hides the page: they sit above the mobile nav.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((list) => removeToast(list, id)), []);
  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      setItems((list) => addToast(list, input, id));
      setTimeout(() => dismiss(id), toastDurationMs(input.tone ?? "info"));
    },
    [dismiss],
  );
  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 md:inset-x-auto md:bottom-4 md:right-4 md:items-end" aria-label="Notifications">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg ${STYLE[t.tone]}`}
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t.title}</p>
              {t.description ? <p className="mt-0.5 text-xs opacity-90">{t.description}</p> : null}
            </div>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label={`Dismiss: ${t.title}`}
              data-compact
              className="rounded px-1 text-lg leading-none opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {"\u00d7"}
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Show a toast. Outside a provider (a test, a stray render) it quietly does nothing. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? { toast: () => undefined };
}
