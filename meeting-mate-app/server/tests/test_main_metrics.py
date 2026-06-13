"""Issue #124: log_request_metrics middleware の smoke test。

Next.js dev proxy で /invoke が ECONNRESET になる原因切り分けのために、
全リクエストの所要時間とレスポンスサイズをログに残す middleware を追加した。
本テストは middleware が import 可能で、最低限ログを出力することのみ確認する。
完全な相関分析は別途 E2E で実施する。
"""
import os
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock

SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from main import log_request_metrics  # noqa: E402


def _make_request(method="POST", path="/invoke"):
    request = MagicMock()
    request.method = method
    request.url = MagicMock()
    request.url.path = path
    return request


def _make_response(status=200, content_length="1234"):
    response = MagicMock()
    response.status_code = status
    response.headers = {"content-length": content_length} if content_length else {}
    return response


class LogRequestMetricsTests(unittest.IsolatedAsyncioTestCase):
    async def test_emits_metrics_log_with_known_size(self):
        request = _make_request(method="POST", path="/invoke")
        response = _make_response(status=200, content_length="9876")
        call_next = AsyncMock(return_value=response)

        with self.assertLogs("main", level="INFO") as logs:
            result = await log_request_metrics(request, call_next)

        self.assertIs(result, response)
        call_next.assert_awaited_once_with(request)
        # ログに [metrics] が含まれ、path / size がそのまま出ること
        joined = "\n".join(logs.output)
        self.assertIn("[metrics]", joined)
        self.assertIn("path=/invoke", joined)
        self.assertIn("status=200", joined)
        self.assertIn("size=9876", joined)
        self.assertIn("elapsed_ms=", joined)

    async def test_falls_back_when_content_length_missing(self):
        request = _make_request(method="GET", path="/api/config")
        response = MagicMock()
        response.status_code = 200
        response.headers = {}  # content-length なし（streaming response 想定）
        call_next = AsyncMock(return_value=response)

        with self.assertLogs("main", level="INFO") as logs:
            await log_request_metrics(request, call_next)

        joined = "\n".join(logs.output)
        self.assertIn("size=?", joined)


if __name__ == "__main__":
    unittest.main()
