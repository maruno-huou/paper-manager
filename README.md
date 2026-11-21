# Simple Paper Manager

*English follows Japanese.* ([Jump to English](#english))

学術論文（PDF）の整理・閲覧・AIによる読解支援・数式対応メモを1画面で完結させる、シンプルな論文管理Webアプリです。

## 主な機能

- **多階層フォルダ管理**：`/` 区切りでのフォルダ整理とドラッグ＆ドロップ移動に対応
- **PDFビューア＆リーディングモード**：PDFの閲覧に加え、文字サイズ変更・テーマ切替・3色マーカーが使えるリーディングモードを搭載（iOS描画対応）
- **AIアシスタント（Gemini）**：PDFからの自動要約・構造化アブストラクト抽出、論文内容を踏まえた多言語チャット（日・英・中）
- **数式・色対応メモ帳**：4色の直接色付け、Markdown、KaTeXによるTeX数式レンダリング、自動保存に対応
- **リアルタイム同期**：Firebase Firestoreによるチャット・メモ・マーカーのデバイス間同期（PDF本体はブラウザのIndexedDBにローカル保存）

## デモモード

初期状態は **Demo モード** で起動します。サンプル論文（3本）を使って、アカウント登録やデータベース設定なしで全機能をお試しいただけます。  
※自分専用モード（Personal）に切り替えるには、画面左上のタイトルをダブルクリック（または `Demo` バッジをクリック）して合言葉を入力します。

## 技術スタック

- **Frontend**: React, Vite
- **Database / Hosting**: Firebase Firestore, Firebase Hosting
- **AI**: Google Gemini API (`@google/generative-ai`)
- **PDF / Math**: PDF.js (`pdfjs-dist`), KaTeX

## ローカル実行方法

1. リポジトリをクローンして依存パッケージをインストール
   ```bash
   git clone https://github.com/maruno-huou/simple-paper-manager.git
   cd simple-paper-manager
   npm install
   ```

2. プロジェクト直下に `.env` ファイルを作成
   ```env
   VITE_FIREBASE_API_KEY=your_firebase_api_key
   VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your_project_id
   VITE_GEMINI_API_KEY=your_gemini_api_key
   VITE_SECRET_PASSCODE=your_passcode
   ```

3. 開発サーバーを起動
   ```bash
   npm run dev
   ```

---

<a id="english"></a>

# Simple Paper Manager (English)

A simple, all-in-one web application for organizing and reading academic PDFs, getting AI-powered reading assistance, and taking math-ready notes in a single workspace.

## Features

- **Nested Folder Management**: Organize papers with `/`-separated hierarchical folders and drag-and-drop sorting
- **PDF Viewer & Reading Mode**: Built-in PDF viewer (with iOS Canvas rendering support) and a clean Reading Mode with adjustable font sizes, themes, and 3-color highlights
- **AI Assistant (Gemini)**: Automatic summaries, structured abstract extraction from PDFs, and multilingual chat (EN / JA / ZH) grounded in the paper's content
- **Rich & Math-Ready Notes**: 4-color text formatting, Markdown, TeX math rendering via KaTeX, and auto-save
- **Real-Time Sync**: Syncs chats, notes, and highlights across devices via Firebase Firestore (PDF files are stored locally in IndexedDB)

## Demo Mode

The app launches in **Demo Mode** by default with 3 sample papers, allowing you to try all features without creating an account or setting up a database.  
*To switch to Personal Mode, double-click the app title in the top-left corner (or click the `Demo` badge) and enter your passcode.*

## Tech Stack

- **Frontend**: React, Vite
- **Database / Hosting**: Firebase Firestore, Firebase Hosting
- **AI**: Google Gemini API (`@google/generative-ai`)
- **PDF / Math**: PDF.js (`pdfjs-dist`), KaTeX

## Local Setup

1. Clone the repository and install dependencies
   ```bash
   git clone https://github.com/maruno-huou/simple-paper-manager.git
   cd simple-paper-manager
   npm install
   ```

2. Create a `.env` file in the project root
   ```env
   VITE_FIREBASE_API_KEY=your_firebase_api_key
   VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
   VITE_FIREBASE_PROJECT_ID=your_project_id
   VITE_GEMINI_API_KEY=your_gemini_api_key
   VITE_SECRET_PASSCODE=your_passcode
   ```

3. Start the development server
   ```bash
   npm run dev
   ```