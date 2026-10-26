"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useFormStatus } from "react-dom";
export function DesignSubmit({
  children,
  name,
  value,
  secondary = false,
  disabled = false,
}: {
  children: React.ReactNode;
  name?: string;
  value?: string;
  secondary?: boolean;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      className={secondary ? "design-button secondary" : "design-button"}
      type="submit"
      name={name}
      value={value}
      disabled={pending || disabled}
    >
      {pending ? "保存中…" : children}
    </button>
  );
}
export function DesignRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [active, router]);
  return active ? (
    <p className="design-muted" role="status">
      処理中です。この画面は自動で更新されます。
    </p>
  ) : null;
}
