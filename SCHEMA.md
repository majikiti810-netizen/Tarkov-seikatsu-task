# デイリー任務 インポート / エクスポート スキーマ

バージョン: `1.0`  
用途: 会議メモなどから生成した JSON を取り込み、アプリ内で「未確認」として微調整・承認する。

## ルートオブジェクト

```json
{
  "schemaVersion": "1.0",
  "exportedAt": "2026-10-05T10:00:00.000Z",
  "mainTasks": [],
  "shopping": [],
  "medications": []
}
```

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `schemaVersion` | string | 推奨 | `"1.0"` |
| `exportedAt` | string (ISO8601) | 任意 | エクスポート日時 |
| `mainTasks` | MainTask[] | 任意 | メインタスク一覧 |
| `shopping` | ShoppingItem[] | 任意 | 買い物リスト |
| `medications` | Medication[] | 任意 | 服薬登録 |

## MainTask

```json
{
  "title": "週次レビュー準備",
  "trader": "自分",
  "desc": "会議で決めた準備項目",
  "deadline": "2026-10-06T18:00:00.000Z",
  "location": "市役所",
  "status": "unaccepted",
  "subs": [
    { "title": "資料を印刷する", "done": false }
  ],
  "deliveries": [
    { "name": "レビュー資料.pdf", "qty": 1, "type": "deliverable", "done": false },
    { "name": "付箋", "qty": 1, "type": "purchase", "done": false }
  ]
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `title` | string | 任務名（必須） |
| `trader` | string | 発注者ラベル |
| `desc` | string | 説明 |
| `deadline` | string \| null | ISO8601 期限 |
| `location` | string | 場所（任意・既定 `""`）。例: `"市役所"` `"西条駅"`。任務詳細に「場所:」として表示 |
| `status` | string | エクスポート時の状態。インポート時は常に `pending_review`（未確認）になる |
| `subs` | SubTask[] | サブタスク |
| `deliveries` | Delivery[] | 納品タスク |

### SubTask
- `title` (string, 必須)
- `done` (boolean, 既定 false)

### Delivery
- `name` (string, 必須)
- `qty` (number, 既定 1)
- `type` (`"deliverable"` \| `"purchase"`, 既定 `"deliverable"`)
- `done` (boolean, 既定 false)

## ShoppingItem

```json
{ "name": "牛乳", "qty": 1, "checked": false, "note": "" }
```

## Medication

```json
{
  "name": "ビタミン",
  "dose": "1錠",
  "times": ["08:00", "朝"],
  "linkToDailyTask": true,
  "enabled": true
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `name` | string | 薬名 |
| `dose` | string | 用量表示 |
| `times` | string[] | `"朝"` / `"昼"` / `"夜"` または `"HH:MM"` |
| `linkToDailyTask` | boolean | 日次メインタスク「服薬」にサブタスクとして載せる |
| `enabled` | boolean | 有効フラグ |

## インポート時の挙動

1. `mainTasks` はすべて **未確認 (`pending_review`)** で追加される。
2. ユーザーはレビュー画面で編集 → **承認** または **破棄** する（微調整＆確認）。
3. 承認後の初期ステータスは **未受注 (`unaccepted`)**。
4. `shopping` / `medications` は既存リストに追記（同名でも重複追加可）。

## 会議メモからの自動生成（将来）

会議文字起こしやカレンダー予定から本スキーマの JSON を生成し、本アプリのインポートに渡す想定。  
デモ版では自動生成エンジンは含まず、スキーマと手動／チャット入力・インポート UI までを提供する。


## ローカル拡張（エクスポート対象外・端末内）

アプリ状態に以下を保持（JSONエクスポートの `schemaVersion 1.0` には含めない）:

- `bathLog`: `{ "YYYY-MM-DD": true|false }` 入浴した / なし
- `localOutings`: `{ "YYYY-MM-DD": true }` 「明日予定あり」等のローカル印
- `bathMeta`: `{ lastSeenDay, streakWarnedFor }` 連続なし判定用

規則: 予定がある日の**前日**は入浴必須。連続スキップは3日目から赤警告（例: 入浴なし3日目）。

- `laundryLog` / `cleanLog` / `trashLog`: `{ "YYYY-MM-DD": true|false }` 洗濯・掃除・ゴミ出し
- `choreMeta`: `{ lastSeenDay, warnedFor }` 必須未完了の警告用

規則:
- **洗濯・掃除**: 毎週月曜・木曜（必須）。完了条件例: 洗濯完了チェック／掃除は1か所15分＋写真1枚（メモ可）。翌朝（火・金）にゴミ出しできる流れ。
- **ゴミ出し（燃えるゴミ）**: 西条地区は火曜・金曜の朝。洗濯・掃除の翌朝を想定。

## 会話タブの1文パース（parser.js）

会話タブに自然な日本語を1文入力すると、`parser.js`（DOM非依存）が以下に分解してプレビューを出し、「追加する」1回で反映する。

| 項目 | 抽出ルール（例） | 反映先 |
|---|---|---|
| 任務 | 残りの本文（例: 住民票 / 年金の書類を出す）。場所＋「行く」だけなら「市役所へ行く」 | `MainTask.title` |
| 日時 | 今日・明日・明後日・(来週)金曜・10/20・10月20日・20日 ＋ 10時 / 10:30 / 14時半 / 午後3時 | `MainTask.deadline` |
| 期限 | 日付の直後の「まで(に)」「締切」「期限」、または「締切は〜」「期限は〜」 | `MainTask.deadline`（時刻なしは 23:59） |
| 場所 | 役所/病院/駅/銀行/郵便局/学校/店/クリニック/歯科… ＋ で/に/へ/まで | `MainTask.location` |
| 持ち物 | 〜を持っていく / 持参 / 忘れずに〜 / 持ち物は〜（と・、・で区切り） | サブタスク「持ち物: 〜」1件ずつ |
| 買うもの | 同じ文中の 〜を買う / 購入 | 買い物リストに追加（任務と同時） |
| メモ | 〜さんと / 〜のため / その他の残り | `MainTask.desc` |

- 「牛乳と卵を買う」のような買い物だけの文 → 従来通り買い物リストのみ。
- 「朝と夜にビタミンを飲む」のような服薬文 → 従来通り服薬登録（同名は時刻マージ）。
- 明日の日時が入った任務は、従来通り「入浴（前日必須）」判定の対象になる。
- テスト: `node tests/parse.test.mjs`
