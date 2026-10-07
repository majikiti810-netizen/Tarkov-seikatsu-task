# Tarkov生活タスク（デイリー任務）

Tarkov風の生活サポートPWAデモ。タブ：任務・会話・買い物・服薬。任務画面上部で入浴記録（明日予定あり→必須／連続なし3日目から赤警告）。

- サイト本体はリポジトリ直下（`index.html`）。ビルド不要の静的サイトです。
- Cloudflare Pages 設定：Framework preset = None / Build command = 空欄 / Build output directory = `/`
- 本番化プラン：[docs/PLAN.md](docs/PLAN.md)
- JSON入出力スキーマ：[SCHEMA.md](SCHEMA.md)

iPhone：Safariで公開URLを開く → 共有 → ホーム画面に追加（通知は iOS 16.4+ かつホーム画面から起動時のみ）。
