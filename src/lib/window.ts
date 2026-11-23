import { isDesktop } from "./bridge";

/** Custom window controls for the frameless Tauri window. */
export async function minimizeWindow(): Promise<void> {
  if (!isDesktop) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().minimize();
}

export async function toggleMaximize(): Promise<boolean> {
  if (!isDesktop) return false;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const window = getCurrentWindow();
  await window.toggleMaximize();
  try {
    return await window.isMaximized();
  } catch {
    return false;
  }
}

export async function closeWindow(): Promise<void> {
  if (!isDesktop) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

export async function isMaximized(): Promise<boolean> {
  if (!isDesktop) return false;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  try {
    return await getCurrentWindow().isMaximized();
  } catch {
    return false;
  }
}
