# Yukashoken Watch

EDINET(金融庁の開示システム)に提出された有価証券報告書・四半期報告書・半期報告書を、登録した銘柄ごとにまとめて確認できる Web アプリです。

GitHub Pages でホストする静的サイトです([https://git-san-934.github.io/yukashoken-watch/](https://git-san-934.github.io/yukashoken-watch/))。サーバーは持たず、すべてブラウザ内で動作します。

姉妹アプリの [IR Watch](https://github.com/git-san-934/ir-watch-app) は東証(TDnet)の適時開示(決算短信・業績修正など)を扱います。有価証券報告書・四半期報告書・半期報告書は**東証ではなく金融庁のEDINET**に提出される別の書類のため、こちらは独立したアプリにしています。

## 機能 (MVP)

- 証券コード(4桁、英字を含むコードにも対応)と会社名で銘柄を登録・削除
- 登録銘柄について、EDINETに提出された有価証券報告書・四半期報告書・半期報告書のメタデータ(会社名・書類種別・対象期間・提出日時)一覧を表示。一度取り込まれた書類は削除するまで残り続けます(下記「保持ポリシー」参照)。新しく取り込まれたものには "NEW" 表示
- 提出から数日以内の書類は、書類内の「主要な経営指標等の推移」(売上高・営業利益・経常利益・当期純利益・EPS等、連結/個別・複数期間分)も併せて表示
- ログイン不要。監視銘柄・書類の記録はすべてブラウザの localStorage にのみ保存され、この端末以外(他人・他のデバイス)からは見えません

比較・スクリーニングなど、財務数値を使った分析機能は未実装です。今後の拡張ポイントとして想定しています。

### 保持ポリシー

- ブラウザが一度取り込んだ書類は、**永続的に**残ります(`src/lib/watchlist.ts` の `mergeArchivedFilings`)
- 「更新」ボタン・再訪問・タブを開いたまま5分おきの自動チェック(タブに戻ってきた時も即チェック)のたびに、まだ取り込んでいない新着分だけを追加で取り込みます(差分マージ)
- ただし、サーバー側(`scripts/fetch-edinet.ts`)は直近30日分のEDINETデータしか保持していません。**30日以上サイトを開かないと、その間に提出された書類は一度も取り込まれずに失われます**(取り込まれた後のものは永続的に残ります)。この期間は `scripts/fetch-edinet.ts` の `DAYS` 定数で調整できます。

## EDINET データについて

有価証券報告書・四半期報告書・半期報告書は**東証(TSE)ではなく金融庁のEDINET**に提出される書類です(TDnetはTSEの適時開示専用で、これらの書類は含まれません)。また2024年4月1日以後開始事業年度から四半期報告書は制度として廃止されており、第1・第3四半期は原則TDnet上の四半期決算短信に、第2四半期はEDINET提出の半期報告書に置き換わっています。そのため `docTypeCode` は 有価証券報告書(120)・四半期報告書(140)・半期報告書(160) とそれぞれの訂正書類(130/150/170)を対象にしていますが、四半期報告書(140/150)は今後件数が減っていく想定です。

- 取得元: [EDINET API v2](https://api.edinet-fsa.go.jp/api/v2)(`scripts/fetch-edinet.ts` がGitHub Actions上で実行)
- 対象: `secCode`(証券コード)が設定されている、すなわち上場している提出者の書類のみ(全上場企業が対象、監視銘柄に限りません — ただし表示は監視銘柄でフィルタします)
- 利用には無料のSubscription-Key(EDINET APIのユーザー登録で取得)が必要です。取得したキーをリポジトリの Settings → Secrets and variables → Actions で `EDINET_API_KEY` として登録してください。**未設定でもデプロイ自体は失敗せず、`scripts/fetch-edinet.ts` がフェッチをスキップするだけです**(サイトは空の状態でデプロイされます)
- 書類一覧(メタデータ)は直近30日分を毎回取得しますが、財務数値(書類内CSVから抽出する「主要な経営指標等の推移」)は**提出から直近3日以内の書類のみ**対象にしています(`scripts/fetch-edinet.ts` の `FINANCIALS_DAYS`)。1つの書類の数値は公開後変わらないため、15分おきの実行のたびに同じZIPを再ダウンロード・再パースするのは無駄という判断です。そのため、**サイトを長期間(3日以上)開かなかった場合、後から取り込まれた書類にはメタデータのみで財務数値が付かないことがあります**。より完全にするにはリポジトリに抽出結果をコミットして永続キャッシュする方式(要 `contents: write` 権限)が考えられますが、現状は見送っています
- CSVパッケージのZIP内部構成(エンコーディング・列名等)はEDINETの公開仕様に基づく実装であり、この開発環境からは実際のAPI呼び出しで検証できていません(`src/lib/edinetFinancials.ts` 参照)。実際のAPIキーでの初回実行時に想定通り動くか確認が必要です

## 技術構成

- Next.js (App Router) + TypeScript, `output: "export"` による静的書き出し
- Tailwind CSS
- 監視銘柄・書類の記録は `localStorage` に保存(サーバー・DBは持たない)

## セットアップ

```bash
npm install
npm run dev
```

[http://localhost:3000](http://localhost:3000) を開いてください。

## テスト・Lint・静的書き出し

```bash
npm test        # vitest によるユニットテスト(EDINET パーサー、watchlist の localStorage 保存)
npm run lint
npx tsc --noEmit
npx tsx scripts/fetch-edinet.ts  # public/edinet-filings.json を生成(EDINET_API_KEY が必要。未設定ならスキップ)
npm run build    # ./out に静的ファイルを生成(ローカルプレビュー用。ルートパス basePath なし)
npm run start    # ./out を http-server でプレビュー
```

## デプロイ

`.github/workflows/deploy.yml` は次のタイミングで実行されます:

- `main` ブランチへの push
- 平日15分おきのスケジュール実行(EDINETスナップショットの更新用)
- Actions タブからの手動実行(workflow_dispatch)

毎回 `scripts/fetch-edinet.ts` で最新のデータを取得し直してから `GITHUB_PAGES=true npm run build` でビルドした `./out`(basePath: `/yukashoken-watch`)を GitHub Pages に公開します。

リポジトリの Settings → Pages → Source を **GitHub Actions** に設定してください(初回のみ手動設定が必要です)。また非公開(Private)リポジトリでは無料プランで GitHub Pages を有効化できないため、公開(Public)リポジトリにしてください。EDINET書類の取り込みを有効にする場合は、Settings → Secrets and variables → Actions で `EDINET_API_KEY` を登録してください(上記「EDINET データについて」参照。IR Watch で既にキーを取得済みの場合は同じキーを使い回せます)。
