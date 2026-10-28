# 権限判定（permissions）

権限はサーバー側の `can(actor, action, resource)` に集める。画面の表示制御だけに頼らない（24.2・AC-17）。

## 使い方

```ts
import { authorize, can } from "../permissions/index.ts";

// 業務関数の先頭で。所有者などの属性は必ずDBから読んで渡す（画面から来た値を信用しない）
const [a] = await tx.select().from(assignments).where(eq(assignments.id, id));
const auth = authorize(actor, "update", { type: "assignment", ownerUserId: a.userId });
if (!auth.ok) return auth; // err("unauthenticated" | "forbidden")

// 表示の出し分けにも使える（ただし判定の本体は業務関数側）
if (can(actor, "read_shared", { type: "company", companyId, sellable, assignedUserId })) { ... }
```

- 業務関数（担当・活動・契約・報酬・ドメイン希望）では `authorizeUser(actor, action, resource, message?)` を使う。
  `authorize` に加えて system・customer を拒否し（業務関数は人の操作として操作者を記録するため）、エラーを `forbidden` に寄せ、型を絞った actor（営業・運営）を返す。
  入口で対象を読む前に人かどうかだけ確かめたいときは `requireUser(actor)`。
- 所有者のある resource は `ownerUserId: null` を受け付ける。「所有者を限定しない」（全件の一覧、運営だけの操作で対象を読む前の確認）の意味で、営業には常に拒否される。
- `actor` は apps/web では `getCurrentActor()`（apps/web/lib/session.ts）から得る。未ログインは `null` で、常に拒否される。
- 利用停止中のユーザーは `AuthProvider.authenticate` が拒否するため、`actor` 自体が作られない。
- `system`（ワーカーの定期ジョブ等）は許可、`customer`（提案リンク）はこの表では常に拒否。提案リンクの判定は share-link 側（`verifyShareLink`）で行う。リンクの発行・取り消しの可否は `shareLink` resource で判定する（承認済みの版か等の業務条件は `issueShareLink` 側）。
- 運営（ops）は原則すべて許可。例外：利用停止・解除の対象は営業ユーザーだけ（自分や他の運営は不可）。

## 営業（sales）の規則の要点

| resource | 営業に許すこと |
| --- | --- |
| company | `read_shared`（担当中か・営業拒否）は常に可。`read`・`claim` は営業可能な候補か自分の担当だけ。`report_refusal` は自分の担当だけ。`manage` 不可 |
| assignment / salesActivity / domainPreference | 自分のもの（ownerUserId が自分）だけ。assignment の `reassign`・`extend`、domainPreference の `confirm` は不可 |
| contract | 自分のものの `read`・`report`（成約報告）だけ。`confirm`・`update` 不可 |
| reward | 自分のものの `read` だけ |
| productTerms | `read` だけ（価格・報酬条件は変更不可） |
| payment / settings / auditLog | 不可 |
| user | 自分の `read` だけ |
| shareLink | `create` は自分が担当中の企業の提案（purpose: proposal）だけ。`revoke` は自分が発行したものだけ。`read` は提案リンクで、自分の担当企業か自分の発行のもの。納品（delivery）のリンクは不可 |
| delivery | 不可（`read`・`manage` とも）。納品は運営が扱い、顧客の承認・修正依頼は共有リンクの検証で判定する（AC-18） |
| contentAccess | `read` だけ。対象企業の有効な担当か、その企業の完了契約の担当営業（salesUserIds に自分が含まれる）のとき。`manage`（招待・解除・役割の変更）は不可（T23） |

業務上の条件（同時担当数の上限・営業拒否中の確保禁止・状態遷移・営業が記録できる抑止の種類・担当確保や成約報告の主体が営業であることなど）はここでは判定しない。各業務関数で判定する。

## 拡張のしかた

`policy.ts` の3か所に追加する。

1. `ResourceMap` に種類と判定に必要な属性を足す（例：`proposal: { ownerUserId: string; companyId: string }`）。
2. `ActionMap` にその種類の操作を足す。
3. `salesPolicies` に営業の規則を書く。書き忘れると型エラーになる。運営に例外があれば `opsRule` に書く。

既存の種類に操作を足した場合も、`salesPolicies` の該当関数で新しい操作を扱う（switch の網羅性で型エラーになる箇所がある）。
許可・拒否の表のテスト（`policy.test.ts`）に行を足す。
