"use client";
import { useEffect, useId } from "react";
import { controlClass, Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select";
import type { MaterialDraft } from "./merge";
export const MATERIALS_CHANGED_EVENT = "siteoffer-materials-changed";
export const materialStatus = {
  pending: "運営の確認待ち",
  needs_changes: "説明の追加が必要",
  accepted: "確認済み",
  withdrawn: "取り下げ済み",
};
export const rightsLabels = {
  own_work: "自社で撮影・制作した画像",
  licensed: "購入・契約した素材",
  permission: "権利者から許可を得た画像",
};
export function useMaterialNavigationGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const unload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const click = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement) || a.target === "_blank" || a.href === location.href) return;
      if (!window.confirm("未送信の入力があります。この画面を離れますか？")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);
}
export function MaterialDetailsFields({ item }: { item?: MaterialDraft }) {
  const id = useId();
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor={`${id}-label`} className="text-sm font-medium">
          素材名
        </label>
        <Input
          id={`${id}-label`}
          name="label"
          required
          maxLength={120}
          placeholder="例：店舗の外観、会社ロゴ"
          defaultValue={item?.label}
        />
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-basis`} className="text-sm font-medium">
          画像を提供できる根拠
        </label>
        <NativeSelect id={`${id}-basis`} name="rightsBasis" required defaultValue={item?.rightsBasis ?? ""}>
          <option value="" disabled>
            選択してください
          </option>
          {Object.entries(rightsLabels).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-note`} className="text-sm font-medium">
          権利と使い方の説明
        </label>
        <textarea
          id={`${id}-note`}
          name="rightsNote"
          className={`${controlClass} min-h-24`}
          required
          minLength={5}
          maxLength={2000}
          defaultValue={item?.rightsNote}
          placeholder="誰が撮影・制作したか、使用許可の内容、配置の希望など"
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">使用を許可する用途</legend>
        <label htmlFor={`${id}-demo`} className="flex gap-2 text-sm">
          <Input id={`${id}-demo`} type="checkbox" name="requestedDemo" defaultChecked={item?.requestedDemo ?? false} />
          営業提案のデモサイト
        </label>
        <label htmlFor={`${id}-production`} className="flex gap-2 text-sm">
          <Input
            id={`${id}-production`}
            type="checkbox"
            name="requestedProduction"
            defaultChecked={item?.requestedProduction ?? false}
          />
          公開する本番サイト
        </label>
      </fieldset>
      <label
        htmlFor={`${id}-confirmed`}
        className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-sm leading-6"
      >
        <Input id={`${id}-confirmed`} type="checkbox" name="confirmed" className="mt-1" required />
        この会社の制作に画像を提供する権限があり、写っている人物などの必要な許可も確認しました
      </label>
    </div>
  );
}
