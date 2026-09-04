# Yukashoken Watch

EDINET(金融庁の開示システム)に提出された、**全上場企業**の有価証券報告書・四半期報告書・半期報告書を一覧・検索できる Web アプリです。

GitHub Pages でホストする静的サイトです([https://git-san-934.github.io/yukashoken-watch/](https://git-san-934.github.io/yukashoken-watch/))。サーバーは持たず、すべてブラウザ内で動作します。

姉妹アプリの [IR Watch](https://github.com/git-san-934/ir-watch-app) は東証(TDnet)の適時開示(決算短信・業績修正など)を扱います。有価証券報告書・四半期報告書・半期報告書は**東証ではなく金融庁のEDINET**に提出される別の書類のため、こちらは独立したアプリにしています。

## 機能 (MVP)

- 直近400日分(約1年強)に提出された、EDINET上の**全上場企業**の有価証券報告書・四半期報告書・半期報告書のメタデータ(会社名・書類種別・対象期間・提出日時)を一覧表示
- 会社名(部分一致)・証券コード(前方一致)に加えて、**各社の最新の有価証券報告書に記載された【事業の内容】のテキスト**からも絞り込み検索(例: GPU / ドローン / 光半導体)
- 提出から数日以内の書類は、書類内の「主要な経営指標等の推移」(売上高・営業利益・経常利益・当期純利益・EPS等、連結/個別・複数期間分)も併せて表示
- ログイン不要。登録・保存の概念はなく、常にサーバー側の最新スナップショットをそのまま表示します

比較・スクリーニングなど、数値を使った分析機能(配当利回りでの絞り込み等)は未実装です。今後の拡張ポイントとして想定しています。

## EDINET データについて

有価証券報告書・四半期報告書・半期報告書は**東証(TSE)ではなく金融庁のEDINET**に提出される書類です(TDnetはTSEの適時開示専用で、これらの書類は含まれません)。また2024年4月1日以後開始事業年度から四半期報告書は制度として廃止されており、第1・第3四半期は原則TDnet上の四半期決算短信に、第2四半期はEDINET提出の半期報告書に置き換わっています。そのため `docTypeCode` は 有価証券報告書(120)・四半期報告書(140)・半期報告書(160) とそれぞれの訂正書類(130/150/170)を対象にしていますが、四半期報告書(140/150)は今後件数が減っていく想定です。

- 取得元: [EDINET API v2](https://api.edinet-fsa.go.jp/api/v2)(`scripts/fetch-edinet.ts` がGitHub Actions上で実行)
- 対象: `secCode`(証券コード)が設定されている、すなわち上場している提出者の書類のみ
- 利用には無料のSubscription-Key(EDINET APIのユーザー登録で取得)が必要です。取得したキーをリポジトリの Settings → Secrets and variables → Actions で `EDINET_API_KEY` として登録してください。**未設定でもデプロイ自体は失敗せず、`scripts/fetch-edinet.ts` がフェッチをスキップするだけです**(サイトは空の状態でデプロイされます)
- 書類一覧(メタデータ)は直近400日分を毎回取得します(1年を通じて分散する各社の決算期をカバーするため)。財務数値(書類内CSVから抽出する「主要な経営指標等の推移」)は**提出から直近3日以内の書類のみ**対象にしています(`scripts/fetch-edinet.ts` の `FINANCIALS_DAYS`)。1つの書類の数値は公開後変わらないため、毎回同じZIPを再ダウンロード・再パースするのは無駄という判断です。そのため、**サイトを長期間(3日以上)開かなかった場合、後から取り込まれた書類にはメタデータのみで財務数値が付かないことがあります**
- 【事業の内容】のテキストは、**各上場企業の最新の有価証券報告書1件のみ**を対象に、実行のたびに毎回抽出し直しています(過去の取得結果を永続的に保存する仕組みは持っていないため)。約4,000社分のCSVパッケージを毎回ダウンロード・解析するため負荷が大きく、この理由で更新頻度を**平日1日1回**に抑えています(下記「デプロイ」参照)。より完全・高頻度にするにはリポジトリに抽出結果をコミットして永続キャッシュする方式(要 `contents: write` 権限)が考えられますが、まずは仕組みをシンプルに保つ現行方式を採用しています
- CSVパッケージのZIP内部構成(エンコーディング・列名等)はEDINETの公開仕様に基づく実装です。実際のAPIキーでの本番稼働で、直近30日分1,600件超の取得・うち直近3日分の財務数値抽出(60件超)がほぼ問題なく動作することを確認済みです(`src/lib/edinetFinancials.ts` 参照)。事業内容テキストの抽出(`DescriptionOfBusinessTextBlock` 要素・約4,000件規模)は、この開発環境のネットワーク制限により実データでの検証ができていません

## 技術構成

- Next.js (App Router) + TypeScript, `output: "export"` による静的書き出し
- Tailwind CSS
- サーバー・DBは持たない。訪問のたびにサーバー側の最新スナップショットを取得して表示するだけで、ブラウザ側に永続保存するデータはありません

## セットアップ

```bash
npm install
npm run dev
```

[http://localhost:3000](http://localhost:3000) を開いてください。

## テスト・Lint・静的書き出し

```bash
npm test        # vitest によるユニットテスト(EDINET パーサー・財務ハイライト抽出)
npm run lint
npx tsc --noEmit
npx tsx scripts/fetch-edinet.ts  # public/edinet-filings.json を生成(EDINET_API_KEY が必要。未設定ならスキップ)
npm run build    # ./out に静的ファイルを生成(ローカルプレビュー用。ルートパス basePath なし)
npm run start    # ./out を http-server でプレビュー
```

## デプロイ

`.github/workflows/deploy.yml` は次のタイミングで実行されます:

- `main` ブランチへの push
- 平日1日1回(6:00 JST)のスケジュール実行(EDINETスナップショットの更新用。事業内容テキストの抽出が全上場企業規模のため、この頻度に抑えています)
- Actions タブからの手動実行(workflow_dispatch)

毎回 `scripts/fetch-edinet.ts` で最新のデータを取得し直してから `GITHUB_PAGES=true npm run build` でビルドした `./out`(basePath: `/yukashoken-watch`)を GitHub Pages に公開します。

リポジトリの Settings → Pages → Source を **GitHub Actions** に設定してください(初回のみ手動設定が必要です)。また非公開(Private)リポジトリでは無料プランで GitHub Pages を有効化できないため、公開(Public)リポジトリにしてください。EDINET書類の取り込みを有効にする場合は、Settings → Secrets and variables → Actions で `EDINET_API_KEY` を登録してください(上記「EDINET データについて」参照。IR Watch で既にキーを取得済みの場合は同じキーを使い回せます)。
