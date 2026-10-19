export type PreviewLoadState = "loading" | "loaded" | "unavailable";
export const PREVIEW_LOAD_TIMEOUT_MS = 15_000;

/** Observe display completion, not HTTP success or content quality. Never read cross-origin contents. */
export function observeSitePreview(
  frame: HTMLIFrameElement,
  changed: (state: PreviewLoadState) => void,
  timeoutMs = PREVIEW_LOAD_TIMEOUT_MS,
) {
  let active = true;
  function complete(fromEvent: boolean) {
    try {
      const document = frame.contentDocument;
      if (document) return document.readyState === "complete" && document.URL !== "about:blank";
    } catch {
      // A cross-origin frame cannot be inspected. Its load event is only a display signal.
    }
    return fromEvent;
  }
  function finish(state: PreviewLoadState) {
    if (!active) return;
    clearTimeout(timer);
    changed(state);
  }
  const loaded = () => {
    if (complete(true)) finish("loaded");
  };
  const failed = () => finish("unavailable");
  changed("loading");
  const timer = setTimeout(failed, timeoutMs);
  frame.addEventListener("load", loaded);
  frame.addEventListener("error", failed);
  // The browser can finish a cached frame before React attaches event handlers during hydration.
  if (complete(false)) finish("loaded");
  return () => {
    active = false;
    clearTimeout(timer);
    frame.removeEventListener("load", loaded);
    frame.removeEventListener("error", failed);
  };
}
