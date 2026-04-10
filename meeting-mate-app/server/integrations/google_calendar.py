"""
Google Calendar 統合 — URL ベース予定作成

Google Calendar の「予定を追加」URL を生成する。
実際の API 呼び出し (OAuth) は行わない MVP 実装。
"""
import re
from urllib.parse import urlencode


def _format_gcal_datetime(iso_string: str) -> str:
    """ISO8601 文字列を Google Calendar URL 用の形式 (YYYYMMDDTHHmmss) に変換する。

    入力例: "2026-04-15T14:00", "2026-04-15T14:00:00", "2026-04-15"
    出力例: "20260415T140000", "20260415"
    """
    cleaned = iso_string.strip()

    # 日付のみ (YYYY-MM-DD)
    if re.match(r"^\d{4}-\d{2}-\d{2}$", cleaned):
        return cleaned.replace("-", "")

    # 日時 (YYYY-MM-DDTHH:MM[:SS])
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?", cleaned)
    if match:
        y, m, d, hh, mm = match.group(1), match.group(2), match.group(3), match.group(4), match.group(5)
        ss = match.group(6) or "00"
        return f"{y}{m}{d}T{hh}{mm}{ss}"

    # パースできない場合はそのまま返す
    return cleaned


async def handle_google_calendar_create(args: dict, meeting_context: dict) -> dict:
    """Google Calendar の予定追加 URL を生成する。

    Returns:
        dict: success, calendar_url, event_summary, start_time, end_time
    """
    summary = args.get("summary", args.get("title", "")).strip()
    if not summary:
        return {"success": False, "message": "予定のタイトル (summary) が必要です。"}

    start_time = args.get("start_time", "").strip()
    end_time = args.get("end_time", "").strip()
    description = args.get("description", "").strip()
    location = args.get("location", "").strip()

    # Google Calendar URL パラメータ組み立て
    params: dict[str, str] = {
        "action": "TEMPLATE",
        "text": summary,
    }

    if start_time:
        gcal_start = _format_gcal_datetime(start_time)
        gcal_end = _format_gcal_datetime(end_time) if end_time else gcal_start
        params["dates"] = f"{gcal_start}/{gcal_end}"

    if description:
        params["details"] = description

    if location:
        params["location"] = location

    calendar_url = f"https://calendar.google.com/calendar/event?{urlencode(params)}"

    return {
        "success": True,
        "calendar_url": calendar_url,
        "event_summary": summary,
        "start_time": start_time,
        "end_time": end_time,
        "message": f"「{summary}」の予定追加リンクを作成しました。リンクをクリックすると Google Calendar に追加できます。",
    }
