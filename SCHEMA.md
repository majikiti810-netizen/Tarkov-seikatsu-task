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
  "reward": "",
  "subs": [
    { "title": "資料を印刷する", "kind": "check", "target": 1, "current": 0, "done": false },
    { "title": "印鑑", "kind": "item", "target": 1, "current": 0, "done": false },
    { "title": "証明写真", "kind": "item", "target": 2, "current": 1, "done": false },
    { "title": "スクワット", "kind": "count", "target": 4, "current": 4, "done": true }
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
| `reward` | string | 報酬（任意・既定 `""`）。自由記述のみ。内容（外出報酬など）は別途ユーザーと決めて入力する。詳細の「報酬」欄に表示 |
| `subs` | SubTask[] | 目標（Objective）。旧称サブタスク |
| `deliveries` | Delivery[] | 納品タスク |

### SubTask（目標 / Objective）
- `title` (string, 必須)
- `kind` (`"check"` \| `"count"` \| `"item"`, 既定 `"check"`)
  - `check`: やる／やった（行タップで切替）。ゲージ 0/1 → 1/1
  - `count`: 回数・数量。`current`/`target` を −／＋（ゲージのタップでも +1）で増減。例「ゴミ袋にまとめる 4/4 ✓」
  - `item`: 必要物品・持ち物。「揃えた」ボタン（Tarkov の「引き渡す」相当、タップで戻せる）。`target>1` なら −／＋ も可
- `target` (number ≥1, 既定 1) 目標数
- `current` (number 0..target, 既定 0) 現在数
- `done` (boolean, 既定 false) `current >= target` と同期（target=1 の check/item は `done` が基準）

移行（v8 / 2026-10-07）: 既存のサブタスクは読込時に `kind:"check", target:1, current: done?1:0` を補完。タイトルが `持ち物: 〜` のものは `kind:"item"` にして接頭辞を外す。インポートも同じ規則。
任務の進捗 = 達成した目標数（＋納品済み数）/ 全目標数（＋納品数）。一覧と詳細にゲージ表示。

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
| `linkToDailyTask` | boolean | 互換用（現在は有効な薬はすべて「服薬」任務に載る） |
| `enabled` | boolean | 有効フラグ |

### 服薬の扱い（v8）
服薬のチェックは**任務タブのシステム任務「服薬」**で行う（独立した服薬タブは廃止）。有効な薬の各時刻が1行の目標になる（例: `朝 コンサータ 27mg×2錠` / `08:00`、時刻順）。行タップで `medLog` に記録し、本日の進捗（例 1/3）を表示。予定時刻を過ぎた未服用は黄色で「時刻超過」。
薬の登録・編集・削除・時刻・通知許可は「服薬」任務の「⚙ 薬を管理」または ⚙設定 →「服薬設定」のシートから。会話タブからの服薬登録も従来通り。
`medLog`: `{ "YYYY-MM-DD": { "<medId>__HH:MM": true } }`（日替わりで自動的に未服用へ）

### 期限（deadline）の表示
期限付き任務は一覧・詳細に残り時間を `6日 18:29:59` / `20:11:55` 形式で1秒ごとに表示。24時間未満=黄、3時間未満=赤、超過=赤「期限切れ +HH:MM:SS」。受注中に期限を過ぎると従来通り失敗（fail SE）。

### 任務一覧のグループ
- 必須タスク: システム任務（服薬・入浴・洗濯・掃除・ゴミ出し）＋毎日の必須タスク
- 期限付きタスク: `deadline` あり（期限の近い順）
- その他
各グループは見出しタップで折りたたみ、「完了を表示」で完了任務の表示切替（端末内の表示設定のみ・エクスポート対象外）。詳細右上に場所（未設定は「任意の場所」）。

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
| 持ち物 | 〜を持っていく / 持参 / 忘れずに〜 / 持ち物は〜、または任務行の直後の名詞だけの行 | 目標 `kind:"item"`（必要物品）1件ずつ |
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
