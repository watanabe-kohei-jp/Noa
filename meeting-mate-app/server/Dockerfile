# Pythonの公式イメージをベースとして使用
FROM python:3.11-slim

# 作業ディレクトリを設定
WORKDIR /app

# 必要なライブラリをインストールするためのrequirements.txtをコピー
COPY requirements.txt .

# pipをアップグレードし、requirements.txtに記載されたライブラリをインストール
# hadolint ignore=DL3013
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# アプリケーションのソースコードをコピー
COPY . .

# FastAPIアプリケーションがリッスンするポートを指定 (Uvicornのデフォルトは8000)
EXPOSE 8000

# アプリケーションを起動するコマンド
# 認証: Application Default Credentials (Cloud Run runtime SA) を使用 (Issue #135)
# 環境変数: PROJECT_ID, REGION, LLM_MODEL は平文 env、FIREBASE_DATABASE_URL /
#           ENCRYPTION_KEY / GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY は
#           Secret Manager から secret_key_ref 経由で注入される (Issue #135)
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT} --app-dir /app
