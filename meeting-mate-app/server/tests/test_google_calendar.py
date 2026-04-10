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

    def test_passthrough_on_unknown_format(self):
        self.assertEqual(_format_gcal_datetime("next monday"), "next monday")


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


if __name__ == "__main__":
    unittest.main()
