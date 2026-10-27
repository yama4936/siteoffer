"use client";
import { useEffect, useRef, useState } from "react";

export type PreviewDevice = "desktop" | "mobile";

/** 見ている端末に合わせて PC/スマホ表示を選ぶ。利用者が切り替えた後は、画面幅が変わってもその選択を保つ */
export function usePreviewDevice(): [PreviewDevice, (next: PreviewDevice) => void] {
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const chosen = useRef(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const sync = () => {
      if (!chosen.current) setDevice(media.matches ? "mobile" : "desktop");
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  const choose = (next: PreviewDevice) => {
    chosen.current = true;
    setDevice(next);
  };
  return [device, choose];
}
