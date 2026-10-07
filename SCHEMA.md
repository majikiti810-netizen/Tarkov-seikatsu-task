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
  "start": "2026-10-06T01:00:00.000Z",
  "end": null,
  "source": "chat",
  "externalId": null,
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
| `start` | string \| null | 予定の開始 ISO8601（チャットの「日時」= 予定時刻。期限のみの場合は null） |
| `end` | string \| null | 予定の終了 ISO8601（将来のカレンダー取り込み用。現状 null） |
| `source` | string \| null | 由来: `"chat"` / `"manual"` / `"import"` / `"daily"` / 将来 `"calendar"` |
| `externalId` | string \| null | 外部ID（将来: カレンダーのイベントID。重複取り込み防止用） |
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
- `dailyRequired`: 毎日の必須タスク（繰り返し）の定義
  ```json
  { "id": "id_x", "title": "散歩", "time": "07:00", "location": "", "bring": [], "memo": "",
    "recurring": "daily", "required": true, "enabled": true, "createdAt": 1791350000000 }
  ```
  入浴・家事と同じく、毎日 `tasks` に `isDailyRequired: true, dailyId, dayKey` の任務として再生成（前日分の結果は `dailyLog` に記録してリセット）。`time` があればアプリ表示中にリマインド通知。任務を削除すると定義も削除。
- `dailyLog`: `{ "YYYY-MM-DD": { "<dailyId>": true|false } }` 毎日の必須タスクの達成記録

規則:
- **洗濯・掃除**: 毎週月曜・木曜（必須）。完了条件例: 洗濯完了チェック／掃除は1か所15分＋写真1枚（メモ可）。翌朝（火・金）にゴミ出しできる流れ。
- **ゴミ出し（燃えるゴミ）**: 西条地区は火曜・金曜の朝。洗濯・掃除の翌朝を想定。

## 会話タブのパース（parser.js）

会話タブに自然な日本語（1文、または改行・箇条書きの複数行）を入力すると、`parser.js`（DOM非依存）が項目ごとに分解してプレビューを出し、「追加する」／「まとめて追加」1回で反映する。

| 項目 | 抽出ルール（例） | 反映先 |
|---|---|---|
| 任務 | 抽出後の残り本文を要約（例: 住民票 / 年金の書類を出す）。場所＋「行く」だけなら「市役所へ行く」。原文そのままは何も抽出できない時だけ | `MainTask.title` |
| 日時 | 今日・明日・明後日・(来週/今度)金曜・10/20・10月20日・20日 ＋ 10時 / 10:30 / 14時半 / 午後3時 | `MainTask.deadline`, `start` |
| 期限 | 日付の直後の「まで(に)」「締切」「期限」、または「締切は〜」「期限は〜」 | `MainTask.deadline`（時刻なしは 23:59） |
| 場所 | 役所/病院/駅/銀行/郵便局/学校/店/クリニック/歯科/セブン/ローソン… ＋ で/に/へ/まで。見出しが場所名だけでも可 | `MainTask.location` |
| 持ち物 | 〜を持っていく / 持参 / 忘れずに〜 / 持ち物は〜、または任務行の直後の名詞だけの行 | サブタスク「持ち物: 〜」1件ずつ |
| 買うもの | 〜を買う / 購入 / 調達 / 補充 / 〜が切れた / なくなった | 買い物リスト（任務と同時も可） |
| メモ | 〜さんと / 〜のため / その他の残り | `MainTask.desc` |

種類（プレビューのボタンで変更可。破線＝推定）:

| 種類 | 推定条件 |
|---|---|
| 服薬 | 用量（`10mg` `×2錠` `1カプセル` `1包`…）、または 薬/飲む/服用/ビタミン/サプリ。用量つきは複数薬に分割（例: 「朝コンサータ27mg×2錠 ストラテラ40mg×1錠」→2件、「服薬タブを変更」等の命令語は除去）。入力どおり記録するだけで助言はしない |
| 買い物 | 買う意図のみ（任務本文・持ち物なし） |
| 毎日の必須 | 毎日 / 毎朝 / 毎晩 / 必須 / 日課（日付指定なし）。毎朝→08:00、毎晩→20:00 |
| メイン任務 | 日時・期限・場所・持ち物・買うもののいずれか |
| サブタスク | 上記なし（インボックス任務に追加） |

- 「サブタスクではなくメイン任務」「買い物にして」のような訂正文は任務にせず、直前の未確定プレビューの種類を変更（不明・対象なしの場合は聞き返す）。
- 複数行: 改行と行頭の `・ - * • ● 1. 1) ① (1)` で分割。「買い物:」見出しの下の行は買うもの、「持ち物:」や任務行の直後の名詞だけの行はその任務の持ち物。各項目に種類ボタンと「スキップ」。
- 明日の日時が入った任務は、従来通り「入浴（前日必須）」判定の対象になる（毎日の必須タスクは対象外）。
- テスト: `node tests/parse.test.mjs`
