"""
Google Calendar 統合 — URL ベース予定作成

Google Calendar の「予定を追加」URL を生成する。
実際の API 呼び出し (OAuth) は行わない MVP 実装。
"""
import re
from datetime import datetime
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

JST = ZoneInfo("Asia/Tokyo")


def _format_gcal_datetime(iso_string: str) -> str:
    """ISO8601 文字列を Google Calendar URL 用の形式 (YYYYMMDDTHHmmss) に変換する。

    timezone-aware な入力（+09:00 や Z）は JST に変換してから naive 文字列化する。
    URL 側で ctz=Asia/Tokyo を付与する前提なので戻り値は常に naive。

    入力例: "2026-04-15T14:00", "2026-04-15T14:00:00+09:00", "2026-04-15T05:00:00Z", "2026-04-15"
    出力例: "20260415T140000", "20260415"

    Raises:
        ValueError: パース不能な入力（例: "next monday"）
    """
    cleaned = iso_string.strip()

    # 日付のみ (YYYY-MM-DD)
    if re.match(r"^\d{4}-\d{2}-\d{2}$", cleaned):
        return cleaned.replace("-", "")

    dt = datetime.fromisoformat(cleaned.replace(" ", "T").replace("Z", "+00:00"))
    if dt.tzinfo is not None:
        dt = dt.astimezone(JST).replace(tzinfo=None)
    return dt.strftime("%Y%m%dT%H%M%S")


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
        try:
            gcal_start = _format_gcal_datetime(start_time)
            gcal_end = _format_gcal_datetime(end_time) if end_time else gcal_start
        except ValueError:
            return {
                "success": False,
                "message": f"start_time / end_time のフォーマットが不正です: start={start_time!r} end={end_time!r}",
            }
        params["dates"] = f"{gcal_start}/{gcal_end}"
        params["ctz"] = "Asia/Tokyo"

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
