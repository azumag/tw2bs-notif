# Bluesky streaming status API 検証メモ

`app.bsky.actor.status`(いわゆる「配信中/ストリーミング状態」)の仕様を、一次情報と実機検証で確認した記録。

## 検証日時
2026-08-07(実機検証済み)

## 概要

Bluesky のプロフィールに表示される「配信中」(LIVE)バッジは、ユーザーのリポジトリに `app.bsky.actor.status` record(rkey: `self`)を書くことで設定できる。

**設定方法は公式アプリ自身と同じ `com.atproto.repo.putRecord` 方式**。専用 XRPC(`app.bsky.actor.putStatus`)はサーバーに存在するが、lexicon 未公開・オープンソース実装なし・公式アプリも不使用のため、採用しない。

## 検証済み仕様

### レコード形式

```
collection: app.bsky.actor.status
rkey:       self (固定)
```

```jsonc
{
  "$type": "app.bsky.actor.status",
  "status": "app.bsky.actor.status#live",  // knownValues 唯一の値
  "createdAt": "2026-08-07T02:00:00.000Z", // 必須
  "durationMinutes": 720,                   // 実質必須(下記クランプ参照)
  "embed": {
    "$type": "app.bsky.embed.external",
    "external": {
      "$type": "app.bsky.embed.external#external",
      "uri": "https://www.twitch.tv/<channel>", // 必須
      "title": "配信タイトル",                    // 任意
      "description": "",                          // 任意
      "thumb": { "$type": "blob", ... }           // 任意(画像アップロードが必要なため省略可)
    }
  }
}
```

### サーバー側の制約(実装ソースから確認)

| 項目 | 内容 | ソース |
|---|---|---|
| rkey | `self` のみインデックス対象 | `packages/bsky/src/data-plane/server/indexing/plugins/status.ts` |
| durationMinutes クランプ | **最小5分 / 最大4時間(240分)** に強制。`expiresAt = インデックス時刻 + (クランプ後) durationMinutes`。4時間超の配信はバッジが自動失効する | `packages/bsky/src/views/index.ts` の `status()` |
| `isActive` | `expiresAt > 現在時刻` で判定され、失効後は `isActive: false` | 同上 |
| `isDisabled` | モデレーターによる停止時のみ、**本人にだけ**返る | 同上 |
| embed のホスト制限 | アプリ側で許可ドメイン制限(β期間中)。**twitch.tv はデフォルト許可** | `social-app/src/features/liveNow/index.tsx` |
| 取得 | `getProfile` は本番で**認証必須**(2026-08-07 実測) | 実機検証 |

### 公式アプリの書き込みパターン(参考実装)

`social-app/src/features/liveNow/index.tsx` の `useUpsertLiveStatusMutation` が正にこの方式。**swapRecord(既存CID)指定 + InvalidSwapError リトライ**で並行更新を回避している:

```ts
const existing = await agent.com.atproto.repo.getRecord({repo, collection: 'app.bsky.actor.status', rkey: 'self'}).catch(() => undefined)
await agent.com.atproto.repo.putRecord({
  repo, collection: 'app.bsky.actor.status', rkey: 'self',
  record, swapRecord: existing?.data.cid || null,
})
```

削除は `com.atproto.repo.deleteRecord`(rkey `self`)。

## 実機検証結果(azumag.bsky.social / 2026-08-07)

1. createSession(アプリパスワード) → ✅ 成功
2. putRecord(上記形式、durationMinutes: 720) → ✅ 成功
   - `expiresAt` は **+4時間**(720分でなくクランプ)に設定されたことを実測確認
3. getProfile(認証あり) → ✅ `status` フィールドに `statusView` が返る
   - `status: "app.bsky.actor.status#live"`, `embed.external.uri: twitch.tv`, `isActive: true`
4. 公式アプリでプロフィールを表示 → ✅ **「配信中」バッジ表示をユーザーが確認**
5. deleteRecord → ✅ 成功し、プロフィールから消滅(getProfile で `status` キー消滅を実測)

## 設計への影響(tw2bs-notif)

1. **4時間クランプへの対応が必須**: 配信中に record を再書き込み(createdAt 更新)して失効をリセットする。cron で30分毎に Helix API で配信状態を確認し、配信中なら再書き込みする(issue #5/#6 で対応)。
2. durationMinutes は大きめ(720 等)に設定する(クランプされるが、安全側)。
3. embed.thumb は省略可能(画像アップロードの複雑さを避ける)。
4. 書き込みは swapRecord + リトライの公式パターンに従う。
5. 削除は必ず stream.offline 時に実施(失効放置でも4時間で消えるが、即時解除のため)。

## 一次ソース

- lexicon: https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/actor/status.json
- AppView indexer: https://github.com/bluesky-social/atproto/blob/main/packages/bsky/src/data-plane/server/indexing/plugins/status.ts
- AppView status view(クランプ): https://github.com/bluesky-social/atproto/blob/main/packages/bsky/src/views/index.ts
- 公式アプリ書き込み実装: https://github.com/bluesky-social/social-app/blob/main/src/features/liveNow/index.tsx
