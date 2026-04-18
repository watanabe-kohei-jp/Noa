import os
import sys
import unittest

SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from integrations.google_calendar import (  # noqa: E402
    handle_google_calendar_create,
    _format_gcal_datetime,
)


class FormatGcalDatetimeTests(unittest.TestCase):
    def test_date_only(self):
        self.assertEqual(_format_gcal_datetime("2026-04-15"), "20260415")

    def test_datetime_with_minutes(self):
        self.assertEqual(_format_gcal_datetime("2026-04-15T14:30"), "20260415T143000")

    def test_datetime_with_seconds(self):
        self.assertEqual(_format_gcal_datetime("2026-04-15T14:30:45"), "20260415T143045")

    def test_datetime_with_space_separator(self):
        self.assertEqual(_format_gcal_datetime("2026-04-15 09:00"), "20260415T090000")

    def test_raises_on_unparseable_input(self):
        with self.assertRaises(ValueError):
            _format_gcal_datetime("next monday")

    def test_datetime_with_jst_offset(self):
        self.assertEqual(
            _format_gcal_datetime("2026-04-15T14:30:00+09:00"), "20260415T143000"
        )

    def test_datetime_with_utc_z_converts_to_jst(self):
        # UTC 05:30 → JST 14:30
        self.assertEqual(
            _format_gcal_datetime("2026-04-15T05:30:00Z"), "20260415T143000"
        )

    def test_datetime_with_other_offset_converts_to_jst(self):
        # EST(-05:00) 00:00 → JST 14:00
        self.assertEqual(
            _format_gcal_datetime("2026-04-15T00:00:00-05:00"), "20260415T140000"
        )

    def test_utc_to_jst_rolls_over_date(self):
        # UTC 2026-04-15T20:00 → JST 2026-04-16T05:00 (日付が繰り上がる)
        self.assertEqual(
            _format_gcal_datetime("2026-04-15T20:00:00Z"), "20260416T050000"
        )


class HandleGoogleCalendarCreateTests(unittest.IsolatedAsyncioTestCase):
    async def test_full_params(self):
        result = await handle_google_calendar_create({
            "summary": "定例会議",
            "start_time": "2026-04-15T14:00",
            "end_time": "2026-04-15T15:00",
            "description": "週次ミーティング",
            "location": "会議室A",
        }, {})

        self.assertTrue(result["success"])
        self.assertIn("calendar.google.com", result["calendar_url"])
        self.assertIn("action=TEMPLATE", result["calendar_url"])
        self.assertIn("text=", result["calendar_url"])
        self.assertEqual(result["event_summary"], "定例会議")
        self.assertEqual(result["start_time"], "2026-04-15T14:00")
        self.assertEqual(result["end_time"], "2026-04-15T15:00")

    async def test_minimal_params(self):
        result = await handle_google_calendar_create({
            "summary": "ランチ",
        }, {})

        self.assertTrue(result["success"])
        self.assertIn("calendar.google.com", result["calendar_url"])
        self.assertEqual(result["event_summary"], "ランチ")

    async def test_empty_summary_fails(self):
        result = await handle_google_calendar_create({
            "summary": "",
        }, {})

        self.assertFalse(result["success"])
        self.assertIn("タイトル", result["message"])

    async def test_missing_summary_fails(self):
        result = await handle_google_calendar_create({}, {})

        self.assertFalse(result["success"])

    async def test_title_as_alias(self):
        """summary がなくても title で受け付ける"""
        result = await handle_google_calendar_create({
            "title": "フォローアップ",
            "start_time": "2026-04-20T10:00",
        }, {})

        self.assertTrue(result["success"])
        self.assertEqual(result["event_summary"], "フォローアップ")

    async def test_url_encoding_special_chars(self):
        result = await handle_google_calendar_create({
            "summary": "会議 & レビュー",
            "description": "テスト用 <desc>",
        }, {})

        self.assertTrue(result["success"])
        # URL-encoded characters should be present
        self.assertNotIn(" & ", result["calendar_url"])
        self.assertIn("%26", result["calendar_url"])

    async def test_dates_in_url(self):
        result = await handle_google_calendar_create({
            "summary": "test",
            "start_time": "2026-04-15T14:00",
            "end_time": "2026-04-15T15:00",
        }, {})

        self.assertIn("dates=20260415T140000", result["calendar_url"])

    async def test_ctz_param_in_url(self):
        result = await handle_google_calendar_create({
            "summary": "test",
            "start_time": "2026-04-15T14:00",
        }, {})

        self.assertIn("ctz=Asia%2FTokyo", result["calendar_url"])

    async def test_timezone_aware_input_normalized(self):
        result = await handle_google_calendar_create({
            "summary": "test",
            "start_time": "2026-04-15T14:30:00+09:00",
            "end_time": "2026-04-15T15:30:00+09:00",
        }, {})

        self.assertTrue(result["success"])
        self.assertIn("dates=20260415T143000%2F20260415T153000", result["calendar_url"])
        self.assertIn("ctz=Asia%2FTokyo", result["calendar_url"])

    async def test_unparseable_start_time_returns_failure(self):
        result = await handle_google_calendar_create({
            "summary": "test",
            "start_time": "next monday",
        }, {})

        self.assertFalse(result["success"])
        self.assertIn("フォーマット", result["message"])

    async def test_error_message_does_not_reflect_user_input(self):
        """UI 向けメッセージに生のユーザー入力を含めない"""
        result = await handle_google_calendar_create({
            "summary": "test",
            "start_time": "malicious<script>",
        }, {})

        self.assertFalse(result["success"])
        self.assertNotIn("malicious", result["message"])

    async def test_end_time_without_start_time_fails(self):
        result = await handle_google_calendar_create({
            "summary": "test",
            "end_time": "2026-04-15T15:00",
        }, {})

        self.assertFalse(result["success"])
        self.assertIn("start_time", result["message"])

    async def test_valid_start_with_invalid_end_returns_failure(self):
        result = await handle_google_calendar_create({
            "summary": "test",
            "start_time": "2026-04-15T14:00",
            "end_time": "next monday",
        }, {})

        self.assertFalse(result["success"])
        self.assertIn("フォーマット", result["message"])


if __name__ == "__main__":
    unittest.main()
