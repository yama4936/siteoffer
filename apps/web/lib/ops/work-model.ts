export const WORK_GROUPS = {
  materials: { label: "写真・ロゴの確認", href: "/ops/materials" },
  publication_materials: { label: "公開後の素材確認", href: "/ops/publication-checks" },
  discovery: { label: "収集の復旧", href: "/ops/discovery" },
  audit_attention: { label: "診断の対応", href: "/ops/processing#audit-attention" },
  design: { label: "デザイン", href: "/ops/designs" },
  proposal: { label: "提案レビュー", href: "/ops/review" },
  sales_ready: { label: "営業への引き継ぎ", href: "/ops/review/ready" },
  consultation: { label: "営業からの相談", href: "/ops/consultations" },
  assignment: { label: "担当の調整", href: "/ops/assignments" },
  contract: { label: "契約確認", href: "/ops/contracts" },
  delivery_start: { label: "制作の着手", href: "/ops/delivery#delivery-start" },
  domain: { label: "ドメイン確認", href: "/ops/delivery#domain-preferences" },
  delivery_recovery: { label: "制作の復旧", href: "/ops/processing?deliveryState=stopped#processing-deliveries" },
  delivery: { label: "制作・公開", href: "/ops/delivery" },
  website: { label: "公式サイト確認", href: "/ops/discovery?pipeline=collected" },
  audit_preparation: { label: "診断の準備", href: "/ops/processing#audit-preparation" },
  preparation: { label: "デザインの準備", href: "/ops/designs" },
} as const;
export type WorkGroup = keyof typeof WORK_GROUPS;
export interface WorkItem {
  id: string;
  group: WorkGroup;
  title: string;
  reason: string;
  action: string;
  href: string;
  since: string;
  priority: number;
  attentionLabel?: string;
}
