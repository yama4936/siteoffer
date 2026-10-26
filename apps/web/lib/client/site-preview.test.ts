import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadSitePreview, PREVIEW_LOAD_TIMEOUT_MS, type PreviewLoadState } from "./site-preview";

class Frame extends EventTarget {
  document: Pick<Document, "URL" | "readyState"> | null = { URL: "about:blank", readyState: "complete" };
  crossOrigin = false;
  navigations: string[] = [];
  navigate?: (url: string) => void;
  set src(url: string) {
    this.navigations.push(url);
    this.navigate?.(url);
  }
  get contentDocument(): Document | null {
    if (this.crossOrigin) throw new DOMException("Cross-origin fixture", "SecurityError");
    return this.document as Document | null;
  }
}
const observe = (frame: Frame, changed: (state: PreviewLoadState) => void) =>
  loadSitePreview(frame as unknown as HTMLIFrameElement, "https://app.example.test/preview", changed);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("observes a cached document that finishes synchronously when navigation starts", () => {
  const frame = new Frame();
  frame.navigate = (url) => {
    frame.document = { URL: url, readyState: "complete" };
    frame.dispatchEvent(new Event("load"));
  };
  const changed = vi.fn();
  const close = observe(frame, changed);
  expect(frame.navigations).toEqual(["https://app.example.test/preview"]);
  expect(changed.mock.calls.map(([state]) => state)).toEqual(["loading", "loaded"]);
  vi.advanceTimersByTime(PREVIEW_LOAD_TIMEOUT_MS * 2);
  expect(changed).toHaveBeenCalledTimes(2);
  close();
});

it("does not count an old completed document as completion of the requested navigation", () => {
  const frame = new Frame(),
    changed = vi.fn();
  frame.document = { URL: "https://app.example.test/old-version", readyState: "complete" };
  const close = observe(frame, changed);
  expect(changed.mock.calls.map(([state]) => state)).toEqual(["loading"]);
  vi.advanceTimersByTime(PREVIEW_LOAD_TIMEOUT_MS);
  expect(changed).toHaveBeenLastCalledWith("unavailable");
  close();
});

it("does not treat about:blank as a completed preview and offers recovery after the deadline", () => {
  const frame = new Frame(),
    changed = vi.fn();
  const close = observe(frame, changed);
  frame.dispatchEvent(new Event("load"));
  vi.advanceTimersByTime(PREVIEW_LOAD_TIMEOUT_MS - 1);
  expect(changed.mock.calls.map(([state]) => state)).toEqual(["loading"]);
  vi.advanceTimersByTime(1);
  expect(changed).toHaveBeenLastCalledWith("unavailable");
  frame.document = { URL: "https://app.example.test/preview", readyState: "complete" };
  frame.dispatchEvent(new Event("load"));
  expect(changed).toHaveBeenLastCalledWith("loaded");
  close();
});

it("waits for actual document completion and cancels the pending deadline after a load", () => {
  const frame = new Frame(),
    changed = vi.fn();
  frame.document = { URL: "https://app.example.test/preview", readyState: "loading" };
  const close = observe(frame, changed);
  frame.dispatchEvent(new Event("load"));
  expect(changed).toHaveBeenCalledTimes(1);
  frame.document = { URL: "https://app.example.test/preview", readyState: "complete" };
  frame.dispatchEvent(new Event("load"));
  vi.advanceTimersByTime(PREVIEW_LOAD_TIMEOUT_MS * 2);
  expect(changed.mock.calls.map(([state]) => state)).toEqual(["loading", "loaded"]);
  close();
});

it("catches even a synchronous cached load when the external document cannot be inspected", () => {
  const frame = new Frame(),
    changed = vi.fn();
  frame.crossOrigin = true;
  frame.navigate = () => frame.dispatchEvent(new Event("load"));
  const close = observe(frame, changed);
  expect(changed.mock.calls.map(([state]) => state)).toEqual(["loading", "loaded"]);
  vi.advanceTimersByTime(PREVIEW_LOAD_TIMEOUT_MS * 2);
  expect(changed).toHaveBeenCalledTimes(2);
  close();
});

it("offers recovery if the browser rejects starting the navigation", () => {
  const frame = new Frame(),
    changed = vi.fn();
  frame.navigate = () => {
    throw new DOMException("Navigation rejected", "SecurityError");
  };
  const close = observe(frame, changed);
  expect(changed.mock.calls.map(([state]) => state)).toEqual(["loading", "unavailable"]);
  close();
  frame.dispatchEvent(new Event("load"));
  vi.advanceTimersByTime(PREVIEW_LOAD_TIMEOUT_MS * 2);
  expect(changed).toHaveBeenCalledTimes(2);
});

it("reports an explicit load error immediately and permits a later successful navigation", () => {
  const frame = new Frame(),
    changed = vi.fn();
  const close = observe(frame, changed);
  frame.dispatchEvent(new Event("error"));
  expect(changed).toHaveBeenLastCalledWith("unavailable");
  frame.document = { URL: "https://app.example.test/preview", readyState: "complete" };
  frame.dispatchEvent(new Event("load"));
  expect(changed).toHaveBeenLastCalledWith("loaded");
  close();
});

it("does not let a discarded preview's events or deadline alter its replacement", () => {
  const oldFrame = new Frame(),
    oldChanged = vi.fn();
  const close = observe(oldFrame, oldChanged);
  close();
  const replacement = new Frame(),
    replacementChanged = vi.fn();
  replacement.navigate = (url) => {
    replacement.document = { URL: url, readyState: "complete" };
    replacement.dispatchEvent(new Event("load"));
  };
  const closeReplacement = observe(replacement, replacementChanged);
  oldFrame.document = { URL: "https://app.example.test/old-version", readyState: "complete" };
  oldFrame.dispatchEvent(new Event("load"));
  oldFrame.dispatchEvent(new Event("error"));
  vi.advanceTimersByTime(PREVIEW_LOAD_TIMEOUT_MS * 2);
  expect(oldChanged.mock.calls.map(([state]) => state)).toEqual(["loading"]);
  expect(replacementChanged.mock.calls.map(([state]) => state)).toEqual(["loading", "loaded"]);
  closeReplacement();
});
