import type { AppEnv } from "../types";
import { hasTwitchSub } from "./sub-check";

/**
 * 特典(サポートコード)基盤。
 * twica と共通仕様: コード文字列を sha256 でハッシュして保存・照合する。
 * Fanbox サポーター向けのコードを管理者が発行し、ユーザーが入力してライセンスを得る。
 */

export interface SupportLicense {
  planType: string;
  fanboxId: string | null;
  activatedAt: string;
}

export class SupportCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportCodeError";
  }
}

export const ALREADY_ACTIVATED = "このコードはすでに利用済みです";
export const INVALID_CODE = "コードが正しくありません";
export const INACTIVE_CODE = "このコードは利用できません";

// プランの序列(大きいほど上位)。twica 準拠: patron > support
const PLAN_RANK: Record<string, number> = { patron: 2, support: 1 };

function planRank(planType: string): number {
  return PLAN_RANK[planType] ?? 0;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * コードを有効化し、ライセンスを付与する。冪等。
 * - 同一コードの再入力 → ALREADY_ACTIVATED
 * - 現在より上位のプランのコード → 既存ライセンスを置き換えて付与
 * - 現在以下のプランのコード → 既存を維持して成功扱い(ダウングレードしない)
 * - 並行リクエスト(二重クリック)では INSERT の成否で勝者を決め、activation_count を二重加算しない
 */
export async function activateCode(
  env: AppEnv,
  userId: string,
  code: string,
  fanboxId?: string,
): Promise<SupportLicense> {
  const codeHash = await sha256Hex(code.trim());

  const codeRow = await env.DB.prepare(
    `SELECT id, plan_type AS planType, status FROM support_codes WHERE code_hash = ?`,
  )
    .bind(codeHash)
    .first<{ id: number; planType: string; status: string }>();
  if (!codeRow) {
    throw new SupportCodeError(INVALID_CODE);
  }
  if (codeRow.status !== "active") {
    throw new SupportCodeError(INACTIVE_CODE);
  }

  // 同一コードの既存ライセンス → 冪等
  const sameCode = await env.DB.prepare(
    `SELECT 1 FROM user_licenses WHERE user_id = ? AND code_id = ?`,
  )
    .bind(userId, codeRow.id)
    .first();
  if (sameCode) {
    throw new SupportCodeError(ALREADY_ACTIVATED);
  }

  // 現行の最上位ライセンス
  const current = await env.DB.prepare(
    `SELECT lc.plan_type AS planType, lc.fanbox_id AS fanboxId, lc.activated_at AS activatedAt
     FROM user_licenses lc
     JOIN support_codes sc ON sc.id = lc.code_id
     WHERE lc.user_id = ? AND sc.status = 'active'
     ORDER BY ${planRankSql()} DESC LIMIT 1`,
  )
    .bind(userId)
    .first<SupportLicense>();

  const newRank = planRank(codeRow.planType);
  const currentRank = current ? planRank(current.planType) : 0;

  // 現在より上位のプランではない → 既存を維持して成功扱い(ダウングレードしない)
  if (current && newRank <= currentRank) {
    return current;
  }

  // INSERT 先行: 並行リクエストが同時に来ても UNIQUE(user_id, code_id) で片方だけ成功する
  const insertRes = await env.DB.prepare(
    `INSERT OR IGNORE INTO user_licenses (user_id, code_id, plan_type, fanbox_id)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(userId, codeRow.id, codeRow.planType, fanboxId ?? null)
    .run();

  if (insertRes.meta.changes === 0) {
    // 並行リクエストに負けた(先勝が INSERT 済み)。負けた側は現在のライセンスを返す
    const winner = await env.DB.prepare(
      `SELECT lc.plan_type AS planType, lc.fanbox_id AS fanboxId, lc.activated_at AS activatedAt
       FROM user_licenses lc
       JOIN support_codes sc ON sc.id = lc.code_id
       WHERE lc.user_id = ? AND sc.status = 'active'
       ORDER BY ${planRankSql()} DESC LIMIT 1`,
    )
      .bind(userId)
      .first<SupportLicense>();
    if (!winner) {
      throw new SupportCodeError(ALREADY_ACTIVATED);
    }
    return winner;
  }

  // 勝った: 旧ライセンスを削除して使用回数を加算
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM user_licenses WHERE user_id = ? AND code_id != ?",
    ).bind(userId, codeRow.id),
    env.DB.prepare(
      `UPDATE support_codes
       SET activation_count = activation_count + 1,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    ).bind(codeRow.id),
  ]);

  return {
    planType: codeRow.planType,
    fanboxId: fanboxId ?? null,
    activatedAt: new Date().toISOString(),
  };
}

// SQL 内で plan_type をランクに変換する(CASE 式)
function planRankSql(alias = "lc"): string {
  const cases = Object.entries(PLAN_RANK)
    .sort((a, b) => b[1] - a[1])
    .map(([plan, rank]) => `WHEN '${plan}' THEN ${rank}`)
    .join(" ");
  return `CASE ${alias}.plan_type ${cases} ELSE 0 END`;
}

/** 有効なライセンス一覧を返す */
export async function listEntitlements(
  env: AppEnv,
  userId: string,
): Promise<SupportLicense[]> {
  const { results } = await env.DB.prepare(
    `SELECT lc.plan_type AS planType, lc.fanbox_id AS fanboxId, lc.activated_at AS activatedAt
     FROM user_licenses lc
     JOIN support_codes sc ON sc.id = lc.code_id
     WHERE lc.user_id = ? AND sc.status = 'active'
     ORDER BY ${planRankSql()} DESC, lc.activated_at ASC`,
  )
    .bind(userId)
    .all<SupportLicense>();
  return results;
}

/** 特典を解除する(ライセンスを全て削除) */
export async function deactivateEntitlements(
  env: AppEnv,
  userId: string,
): Promise<void> {
  await env.DB.prepare("DELETE FROM user_licenses WHERE user_id = ?")
    .bind(userId)
    .run();
}

/**
 * 有効な特典を持っているか。
 * サポートコード(Fanbox)または Twitch サブスクで特典が有効。
 */
export async function hasActiveEntitlement(
  env: AppEnv,
  userId: string,
): Promise<boolean> {
  const licenses = await listEntitlements(env, userId);
  if (licenses.length > 0) return true;
  return hasTwitchSub(env, userId);
}
