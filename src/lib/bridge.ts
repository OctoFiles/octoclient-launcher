/**
 * Bridge between the React UI and the Rust backend.
 *
 * In the Tauri window every call goes through `invoke`. In a plain browser
 * (Vite dev preview) `mock-backend.ts` answers with local data so the UI can be
 * developed without compiling Rust. Nothing mock-related is written to disk.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { BridgeError } from "./errors";
import { mockInvoke } from "./mock-backend";

export { BridgeError };

export const isDesktop =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function normalizeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (typeof error === "object" && error !== null) {
    const record = error as { code?: unknown; message?: unknown };
    if (typeof record.message === "string") {
      return new BridgeError(
        typeof record.code === "string" ? record.code : "unknown",
        record.message,
      );
    }
  }
  if (typeof error === "string") return new BridgeError("unknown", error);
  return new BridgeError("unknown", "Unbekannter Fehler des Launchers.");
}

export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    if (!isDesktop) return await mockInvoke<T>(command, args);
    return await tauriInvoke<T>(command, args);
  } catch (error) {
    throw normalizeError(error);
  }
}

export function errorMessage(error: unknown): string {
  return normalizeError(error).message;
}

export function errorCode(error: unknown): string {
  return normalizeError(error).code;
}

/** Subscribe to a backend event. Returns a cleanup function. */
export async function listenEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!isDesktop) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (message) => handler(message.payload));
}

export async function openExternal(url: string): Promise<void> {
  if (!isDesktop) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("open_external", { url });
}
