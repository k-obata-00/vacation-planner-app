# VacationPlanner

ブラウザの IndexedDB でデータを管理する有給管理 Web アプリです。サーバーサイド DB 不要のフロントエンド SPA です。

## 技術スタック

- **サーバー**: Node.js 組み込み `http` モジュール（静的ファイル配信のみ）
- **言語**: TypeScript（ブラウザ用は `tsc` でコンパイル、サーバーは `tsx` で直接実行）
- **DB**: IndexedDB（ブラウザ内蔵）
- **フロントエンド**: Vanilla TypeScript（バンドル不要）
- **祝日API**: [holidays-jp](https://holidays-jp.github.io/)（ブラウザから直接 fetch）

## セットアップ

```bash
npm install
npm run build   # src/ts/*.ts → src/public/*.js にコンパイル
npm start
```

開発時はターミナルを 2 つ使うと便利です。

```bash
npm run dev         # サーバーをファイル変更で自動再起動
npm run dev:client  # TypeScript を watch コンパイル
```

ブラウザで <http://localhost:3000> を開いてください。

## 機能

### ダッシュボード

- 付与日数・使用日数・残日数・消化率をリアルタイム表示
- 入社年月日から勤続年数を自動算出し、付与ルールに基づいて付与日数を計算
- 繰越日数を加算した合計付与日数を表示
- 残日数に応じた「月あたり必要取得日数」を案内

### 有給登録

- **種別**: 全日 / 午前半日 / 午後半日 / 時間休（時間単位）
- カレンダーの日付クリックでモーダル登録
- ダッシュボードの期間フォームから範囲指定で一括登録
- 同日の社外予定と合算して所定労働時間を超えないよう検証

### 稼働時間外予定（社外予定）

- **種別**: 終日 / 時間指定
- カレンダーの日付クリックから登録・削除
- 有給と組み合わせて同日の稼働時間を正確に管理

### カレンダー

- 月単位での有給・社外予定・祝日の視覚的確認
- `min_work_hours` 設定時は当月の稼働時間サマリーを表示（所定時間・有給控除後の実働・精算幅下限との差分）

### 取得提案

- 少ない有給日数で長い連休を作れる日程を自動提案（1〜3日使用パターン）
- 4 連休以上になる提案のみ表示、日付順・連休日数順でソート可能
- 月フィルターで絞り込み、クリックで一括登録してカレンダーに反映

### 祝日管理

- 初回表示時に当年・翌年分の祝日を外部 API から取得して IndexedDB にキャッシュ
- キャッシュ済みの年は API を呼ばず高速表示
- 設定タブから任意年の個別取得・強制再取得が可能

### 設定

- 入社年月日・繰越日数・所定労働時間・精算幅下限
- 定休曜日（チェックボックスで曜日指定）
- 特定会社休日（夏季休暇・年末年始など個別登録）
- 付与ルール（勤続月数と付与日数のテーブルを自由に編集）

## ファイル構成

```text
VacationPlanner/
├── package.json
├── tsconfig.json        ← ブラウザ用 TS 設定（src/ts → src/public）
├── tsconfig.node.json   ← サーバー用 TS 設定（型チェックのみ）
├── server.ts            ← 静的ファイルサーバー
├── README.md
└── src/
    ├── ts/              ← TypeScript ソース（編集はここ）
    │   ├── db.ts        ← IndexedDB 初期化・スキーマ定義
    │   ├── repo.ts      ← データアクセス層
    │   └── app.ts       ← アプリケーションロジック
    └── public/          ← 配信ファイル（db.js/repo.js/app.js は tsc が生成）
        ├── index.html
        └── style.css
```

## GitHub Pages へのデプロイ

本アプリはすべての処理がブラウザ内で完結するため、GitHub Pages で静的ホスティングできます。

### 手順

#### 1. リポジトリを作成して push する

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/<username>/<repo-name>.git
git push -u origin main
```

#### 2. TypeScript をビルドして `docs/` を作成する

```bash
npm run build                  # src/ts/*.ts → src/public/*.js
cp -r src/public docs          # public の内容を docs/ にコピー
git add docs
git commit -m "add docs for GitHub Pages"
git push
```

> Windows の場合は `cp -r` の代わりに `xcopy src\public docs /E /I /Y` を使用してください。

#### 3. GitHub Pages を有効にする

リポジトリの **Settings → Pages → Build and deployment** で以下を設定します。

- Source: `Deploy from a branch`
- Branch: `main` / `docs`

保存後、数分で `https://<username>.github.io/<repo-name>/` で公開されます。

### 注意事項

- データは各ブラウザの IndexedDB に保存されます。デバイスやブラウザを変えるとデータは引き継がれません。
- `docs/` 内の JS ファイル（`app.js` 等）はビルド成果物です。TypeScript を修正した場合は `npm run build` → `docs/` への再コピーが必要です。

## 動作要件

- **Node.js v18 以上**
- `npm install` でインストールするのは `typescript`・`tsx`・`@types/node` のみ
- データはすべてブラウザの IndexedDB に保存されます（サーバー側に DB ファイルは不要）
