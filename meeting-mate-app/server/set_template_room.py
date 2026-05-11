import firebase_admin
from firebase_admin import db
import os
from dotenv import load_dotenv

load_dotenv()

# Issue #135: SA JSON 依存を廃止し、Application Default Credentials (ADC) を使用。
# ローカル実行時は事前に `gcloud auth application-default login` を実行すること。
try:
    database_url = os.getenv('FIREBASE_DATABASE_URL')
    if not database_url:
        gcp_project_id = os.getenv('GCP_PROJECT_ID')
        if gcp_project_id:
            database_url = f"https://{gcp_project_id}-default-rtdb.firebaseio.com"
            print(f"FIREBASE_DATABASE_URL inferred: {database_url}")
        else:
            raise ValueError(
                "FIREBASE_DATABASE_URL and GCP_PROJECT_ID not set.")

    if not firebase_admin._apps:
        firebase_admin.initialize_app(options={'databaseURL': database_url})
        print("Firebase Admin SDK initialized (ADC).")
    else:
        print("Firebase Admin SDK already initialized.")

    # templateルームの空データ構造
    empty_template_room_data = {
        "sessionId": "template-session",
        "sessionTitle": "テンプレートルーム",
        "startTime": "",
        "ownerId": "",
        "participants": {},
        "tasks": [],
        "notes": [],
        "overviewDiagram": {
            "title": "会議の概要図",
            "mermaidDefinition": "graph TD;\nA[会議開始];"
        },
        "currentAgenda": {
            "mainTopic": "会議開始",
            "details": []
        },
        "suggestedNextTopics": [],
        "transcript": [],
        "last_llm_processed_message_count": 0,
        "representativeMode": False
    }

    # rooms/template パスにデータを書き込む
    template_room_ref = db.reference("rooms/template")
    template_room_ref.set(empty_template_room_data)

    print("Empty template room data successfully written to Firebase Realtime Database at rooms/template.")

except Exception as e:
    print(f"Error writing template room data to Firebase: {e}")
    exit(1)
