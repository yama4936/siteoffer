"use client";

import { Check, Copy, ExternalLink, Info, Link2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { SalesAction, SalesActionState } from "@/lib/sales/action-state";
import {
  proposalShareMessage,
  type ShareCheckAction,
  type ShareHistoryItem,
  shareDate,
  shareState,
  shareTtlOptions,
} from "@/lib/sales/share-presentation";
import { ActionMessage } from "./forms";

const LABEL = { active: "有効", expired: "期限切れ", revoked: "取り消し済み" } as const;

export function ShareWorkspace({
  proposalVersionId,
  issueAction,
  revokeAction,
  checkAction,
  maxHours,
  historyAvailable,
  serverNow,
  links,
}: {
  proposalVersionId: string;
  issueAction: SalesAction;
  revokeAction: SalesAction;
  checkAction: ShareCheckAction;
  maxHours: number;
  historyAvailable: boolean;
  serverNow: string;
  links: ShareHistoryItem[];
}) {
  const router = useRouter();
  const [refreshing, refresh] = useTransition();
  const [now, setNow] = useState(() => Date.parse(serverNow));
  const [revoked, setRevoked] = useState<string[]>([]);
  const [sequence, setSequence] = useState(0);
  const [showPast, setShowPast] = useState(false);
  // サーバー時刻を基準に経過を測る。端末の時刻ずれで期限を延ばさない。
  useEffect(() => {
    const start = performance.now();
    const update = () => setNow(Date.parse(serverNow) + performance.now() - start);
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [serverNow]);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "visible") refresh(() => router.refresh());
    };
    const timer = setInterval(update, 30_000);
    window.addEventListener("focus", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, [router]);
  const history = links.map((l) => ({ ...l, revokedAt: revoked.includes(l.id) ? serverNow : l.revokedAt }));
  const active = history.filter((l) => shareState(l, now) === "active");
  const past = history.filter((l) => shareState(l, now) !== "active");
  function list(items: ShareHistoryItem[]) {
    return (
      <ul className="grid gap-2">
        {items.map((l) => {
          const status = shareState(l, now);
          return (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3">
              <div className="min-w-0 space-y-1 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={status === "active" ? "success" : "secondary"}>{LABEL[status]}</Badge>
                  <span>期限：{shareDate(l.expiresAt)}</span>
                </div>
                <p className="text-muted-foreground text-xs">
                  発行：{shareDate(l.createdAt)} · {l.id.slice(0, 8)}
                </p>
                {l.revokedAt && <p className="text-muted-foreground text-xs">取り消し：{shareDate(l.revokedAt)}</p>}
              </div>
              {status === "active" && (
                <RevokeShareButton
                  action={revokeAction}
                  linkId={l.id}
                  onRevoked={() => setRevoked((ids) => [...ids, l.id])}
                />
              )}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <section aria-label="提案リンクの共有" className="min-w-0 space-y-5">
      <Alert variant="info">
        <Info />
        <AlertDescription>
          改善デモを確認し、期限付きリンクをコピーして顧客へお渡しください。非公式の改善提案です。コピーだけでは送信・活動記録は行われません。
        </AlertDescription>
      </Alert>
      {historyAvailable ? (
        <IssueShareForm
          key={sequence}
          action={issueAction}
          proposalVersionId={proposalVersionId}
          checkAction={checkAction}
          maxHours={maxHours}
          links={history}
          now={now}
          onNew={() => setSequence((n) => n + 1)}
        />
      ) : (
        <Alert variant="destructive">
          <AlertDescription>
            共有履歴を確認できません。接続・担当状況を確認して、履歴を読み直してください。
          </AlertDescription>
        </Alert>
      )}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-sm">自分が発行したリンク · 有効 {active.length}件</h3>
          <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => refresh(() => router.refresh())}>
            <RefreshCw />
            {refreshing ? "確認中…" : "履歴を更新"}
          </Button>
        </div>
        {historyAvailable &&
          (active.length ? list(active) : <p className="text-muted-foreground text-sm">有効なリンクはありません。</p>)}
        {past.length > 0 && (
          <div className="space-y-3">
            <Button variant="ghost" size="sm" aria-expanded={showPast} onClick={() => setShowPast((v) => !v)}>
              期限切れ・取り消し済み {past.length}件 {showPast ? "を閉じる" : "を見る"}
            </Button>
            {showPast && list(past)}
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          日時は日本時間です。URLは発行直後にだけ表示します。控え忘れた場合は不要なリンクを取り消して、新しく発行してください。
        </p>
      </div>
    </section>
  );
}

function IssueShareForm({
  action,
  proposalVersionId,
  checkAction,
  maxHours,
  links,
  now,
  onNew,
}: {
  action: SalesAction;
  proposalVersionId: string;
  checkAction: ShareCheckAction;
  maxHours: number;
  links: ShareHistoryItem[];
  now: number;
  onNew: () => void;
}) {
  const [uncertain, setUncertain] = useState(false);
  const [ttl, setTtl] = useState("");
  const [state, formAction, pending] = useActionState(
    async (_prev: SalesActionState, fd: FormData): Promise<SalesActionState> => {
      try {
        return await action(undefined, fd);
      } catch {
        // 応答を失った場合は成功・失敗を断定せず、再送によるリンクの増殖を防ぐ。
        setUncertain(true);
        return {
          status: "error",
          message: "発行結果を受け取れませんでした。発行済みの可能性があるため、履歴を読み直して確認してください。",
        };
      }
    },
    undefined,
  );
  if (state?.status === "ok" && state.shareUrl && state.shareLinkId && state.shareExpiresAt) {
    const listed = links.find((l) => l.id === state.shareLinkId);
    const status = shareState(listed ?? { expiresAt: state.shareExpiresAt, revokedAt: null }, now);
    return (
      <div className="space-y-3">
        <IssuedShare
          key={state.shareLinkId}
          url={state.shareUrl}
          expiresAt={state.shareExpiresAt}
          linkId={state.shareLinkId}
          proposalVersionId={proposalVersionId}
          status={status}
          checkAction={checkAction}
        />
        <div className="space-y-1">
          <Button variant="outline" onClick={onNew}>
            別のリンクを作成する
          </Button>
          <p className="text-muted-foreground text-xs">新しく発行しても、以前のリンクは取り消されません。</p>
        </div>
      </div>
    );
  }
  const options = shareTtlOptions(maxHours);
  return (
    <form action={formAction} className="grid gap-4">
      <input type="hidden" name="proposalVersionId" value={proposalVersionId} />
      <fieldset disabled={pending || uncertain || !options.length} className="flex min-w-0 flex-wrap items-end gap-3">
        <Field label="リンクの有効期間" htmlFor={`share-ttl-${proposalVersionId}`} className="min-w-40 flex-1">
          <NativeSelect
            id={`share-ttl-${proposalVersionId}`}
            name="ttlHours"
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Button type="submit" disabled={pending || uncertain || !options.length}>
          <Link2 />
          {pending ? "発行しています…" : "共有リンクを発行する"}
        </Button>
      </fieldset>
      {!options.length && (
        <p role="alert" className="text-sm text-destructive">
          有効期間の運営設定を確認してください。
        </p>
      )}
      <ActionMessage state={state} />
      {uncertain && (
        <Button variant="outline" className="w-fit" onClick={() => window.location.reload()}>
          ページを読み直して発行履歴を確認
        </Button>
      )}
    </form>
  );
}

function IssuedShare({
  url,
  expiresAt,
  linkId,
  proposalVersionId,
  status,
  checkAction,
}: {
  url: string;
  expiresAt: string;
  linkId: string;
  proposalVersionId: string;
  status: ReturnType<typeof shareState>;
  checkAction: ShareCheckAction;
}) {
  const [message, setMessage] = useState(() => proposalShareMessage(url, expiresAt));
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  async function copy(kind: "url" | "message") {
    if (inFlight.current || status !== "active" || unavailable) return;
    inFlight.current = true;
    setBusy(true);
    setFeedback("");
    try {
      const result = await checkAction(proposalVersionId, linkId);
      if (result.status !== "ok") {
        setUnavailable(result.unavailable);
        setFeedback(result.message);
        return;
      }
      try {
        await navigator.clipboard.writeText(kind === "url" ? url : message);
        setFeedback(kind === "url" ? "リンクをコピーしました。" : "案内文をコピーしました。");
      } catch {
        const field = kind === "url" ? input.current : textarea.current;
        field?.focus();
        field?.select();
        setFeedback("自動コピーを利用できません。選択した内容をコピーしてください（Ctrl+C / ⌘C、スマホは長押し）。");
      }
    } catch {
      setFeedback("リンクの状態を確認できません。接続を確認して、もう一度コピーしてください。");
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  if (status !== "active" || unavailable)
    return (
      <Alert variant="info">
        <Info />
        <AlertTitle>このリンクは共有できません</AlertTitle>
        <AlertDescription>
          {(unavailable ? feedback : "") ||
            (status === "revoked"
              ? "取り消し済みです。必要な場合は新しいリンクを発行してください。"
              : "閲覧期限を過ぎています。必要な場合は新しいリンクを発行してください。")}
        </AlertDescription>
      </Alert>
    );
  return (
    <div className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
      <div className="space-y-1">
        <p className="flex items-center gap-2 font-semibold text-sm">
          <Check className="size-4 text-success" />
          共有する準備ができました
        </p>
        <p className="text-muted-foreground text-xs">閲覧期限：{shareDate(expiresAt)}（日本時間）</p>
      </div>
      <div className="space-y-2">
        <Field label="共有リンク" htmlFor={`share-url-${linkId}`}>
          <Input
            ref={input}
            id={`share-url-${linkId}`}
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            className="min-w-0 font-mono text-xs"
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={busy} onClick={() => void copy("url")}>
            <Copy />
            リンクをコピー
          </Button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary underline underline-offset-4"
          >
            デモを確認
            <ExternalLink aria-hidden="true" className="size-3.5" />
            <span className="sr-only">（別ウィンドウ）</span>
          </a>
        </div>
      </div>
      <details>
        <summary className="cursor-pointer text-sm font-medium">案内文も一緒にコピーする</summary>
        <div className="mt-3 space-y-2">
          <Field label="顧客に渡す案内文（編集できます）" htmlFor={`share-message-${linkId}`}>
            <Textarea
              ref={textarea}
              id={`share-message-${linkId}`}
              rows={8}
              value={message}
              readOnly={busy}
              onChange={(e) => {
                setMessage(e.target.value);
                setFeedback("");
              }}
            />
          </Field>
          <Button variant="outline" disabled={busy || !message.trim()} onClick={() => void copy("message")}>
            <Copy />
            案内文をコピー
          </Button>
          <p className="text-muted-foreground text-xs">
            相手に合わせて文面を整えてから、お使いのメールなどに貼り付けてください。
          </p>
        </div>
      </details>
      <p role="status" aria-live="polite" className="text-sm">
        {busy ? "共有できる状態か確認しています…" : feedback}
      </p>
      <p className="text-muted-foreground text-xs">
        この画面を閉じるとURLは再表示できません。必要な場所に控えてください。
      </p>
    </div>
  );
}

function RevokeShareButton({
  action,
  linkId,
  onRevoked,
}: {
  action: SalesAction;
  linkId: string;
  onRevoked: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [state, formAction, pending] = useActionState(
    async (_prev: SalesActionState, fd: FormData): Promise<SalesActionState> => {
      try {
        const result = await action(undefined, fd);
        if (result?.status === "ok") onRevoked();
        return result;
      } catch {
        return {
          status: "error",
          message: "取り消し結果を確認できません。履歴を更新するか、もう一度取り消してください。",
        };
      }
    },
    undefined,
  );
  return (
    <form action={formAction} className="grid max-w-full gap-2">
      <input type="hidden" name="linkId" value={linkId} />
      {confirm ? (
        <>
          <p className="text-sm">渡した相手も閲覧できなくなります。取り消しますか？</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" size="sm" disabled={pending}>
              {pending ? "取り消し中…" : "取り消しを確定"}
            </Button>
            <Button variant="outline" size="sm" disabled={pending} onClick={() => setConfirm(false)}>
              戻る
            </Button>
          </div>
        </>
      ) : (
        <Button variant="outline" size="sm" className="w-fit" onClick={() => setConfirm(true)}>
          取り消す
        </Button>
      )}
      <ActionMessage state={state} />
    </form>
  );
}
