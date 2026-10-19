export type PreviewLoadState = "loading" | "loaded" | "unavailable";
export const PREVIEW_LOAD_TIMEOUT_MS = 15_000;

/** Start navigation after installing its display observer. This does not verify HTTP success or quality. */
export function loadSitePreview(
  frame: HTMLIFrameElement,
  url: string,
  changed: (state: PreviewLoadState) => void,
  timeoutMs = PREVIEW_LOAD_TIMEOUT_MS,
) {
  let active = true;
  function complete() {
    try {
      const document = frame.contentDocument;
      if (document) return document.readyState === "complete" && document.URL !== "about:blank";
    } catch {
      // A cross-origin frame cannot be inspected. Its load event is only a display signal.
    }
    return true;
  }
  function finish(state: PreviewLoadState) {
    if (!active) return;
    clearTimeout(timer);
    changed(state);
  }
  const loaded = () => {
    if (complete()) finish("loaded");
  };
  const failed = () => finish("unavailable");
  changed("loading");
  const timer = setTimeout(failed, timeoutMs);
  frame.addEventListener("load", loaded);
  frame.addEventListener("error", failed);
  // SSR and cached cross-origin frames can finish before hydration. Attach first, then navigate.
  try {
    frame.src = url;
  } catch {
    failed();
  }
  return () => {
    active = false;
    clearTimeout(timer);
    frame.removeEventListener("load", loaded);
    frame.removeEventListener("error", failed);
  };
}
