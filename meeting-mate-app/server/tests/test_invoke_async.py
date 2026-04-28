"""Issue #129: /invoke の 202 Accepted + RTDB job 購読パターンのテスト。

主な検証:
- _run_invoke_job が job レコードを queued → running → done/error と遷移させる
- 同一セッションの 2 並列 _run_invoke_job がロックでキュー化されて両方とも完走する
- queue 中に閾値が崩れた場合 (前 job が消化済み) は invokedAgents=[] で done
- orchestrate が例外を投げた場合 status=error + is_llm_processing 解除
- last_llm_processed_message_count が orchestrate 成功後に必ず更新される
- _purge_old_jobs は terminal status (done/error) かつ old のみ削除し、running/queued は残す
- _purge_session_jobs は指定 sessionId にマッチする job のみ削除
- _recover_stale_jobs は running/queued を error: stale_after_restart に格上げ
"""
import asyncio
import copy
import os
import sys
import unittest
from datetime import datetime, timedelta
from unittest.mock import patch

SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

import main  # noqa: E402
from main import (  # noqa: E402
    AgentResult,
    TaskPayload,
    _llm_processing_locks,
    _purge_old_jobs,
    _purge_room_jobs,
    _purge_session_jobs,
    _recover_stale_jobs,
    _run_invoke_job,
)


# ---------------------------------------------------------------------------
# In-memory Firebase RTDB mock
# ---------------------------------------------------------------------------


class _MockRef:
    """firebase_admin.db.reference 互換の最小 in-memory 実装"""

    def __init__(self, store: dict, path: str):
        self._store = store
        self._path = path.strip("/")

    def _segments(self):
        return [s for s in self._path.split("/") if s]

    def _navigate(self, create: bool = False):
        node = self._store
        segs = self._segments()
        for seg in segs[:-1]:
            if not isinstance(node, dict):
                return None, None, None
            child = node.get(seg)
            if child is None:
                if create:
                    child = {}
                    node[seg] = child
                else:
                    return None, None, None
            node = child
        last = segs[-1] if segs else None
        return node, last, segs

    def get(self):
        # 本物の RTDB は snapshot (immutable copy) を返す。mock も copy を返して
        # 反復中の同パス delete が RuntimeError にならないようにする。
        if not self._segments():
            return copy.deepcopy(self._store)
        node, last, _ = self._navigate(create=False)
        if node is None or last is None or not isinstance(node, dict):
            return None
        value = node.get(last)
        return copy.deepcopy(value) if value is not None else None

    def set(self, value):
        if not self._segments():
            self._store.clear()
            if isinstance(value, dict):
                self._store.update(value)
            return
        node, last, _ = self._navigate(create=True)
        node[last] = value

    def update(self, value: dict):
        node, last, _ = self._navigate(create=True)
        existing = node.get(last)
        if not isinstance(existing, dict):
            existing = {}
        existing.update(value)
        node[last] = existing

    def delete(self):
        if not self._segments():
            self._store.clear()
            return
        node, last, _ = self._navigate(create=False)
        if node is not None and last in node:
            del node[last]

    def push(self, value):
        node, last, _ = self._navigate(create=True)
        existing = node.get(last)
        if not isinstance(existing, dict):
            existing = {}
            node[last] = existing
        # 単純なインクリメンタルキーで擬似 push key 化
        push_key = f"-Mock{len(existing):04d}"
        existing[push_key] = value
        return _MockRef(self._store, f"{self._path}/{push_key}")

    def child(self, sub_path: str):
        new_path = f"{self._path}/{sub_path}".strip("/")
        return _MockRef(self._store, new_path)


def _install_mock_db(test_case: unittest.TestCase) -> dict:
    """main.db.reference を in-memory 実装に差し替える。テスト終了時に自動 restore。"""
    store: dict = {}

    def fake_reference(path: str):
        return _MockRef(store, path)

    patcher = patch.object(main.db, "reference", side_effect=fake_reference)
    patcher.start()
    test_case.addCleanup(patcher.stop)
    return store


def _make_payload(room_id: str = "r1", session_id: str = "s1") -> TaskPayload:
    return TaskPayload(
        taskId="test-task",
        messages=[],
        roomId=room_id,
        sessionId=session_id,
        speakerId="u1",
        speakerName="User1",
    )


def _seed_session(store: dict, room_id: str, session_id: str, user_msg_count: int, last_processed: int = 0):
    """session に user メッセージを user_msg_count 個積む"""
    transcript = {
        f"-{i:04d}": {"text": f"msg{i}", "userId": "u1", "userName": "User1",
                      "role": "user", "origin": "human_chat",
                      "timestamp": "2026-04-27T00:00:00Z"}
        for i in range(user_msg_count)
    }
    store["rooms"] = {
        room_id: {
            "participants": {"u1": {"name": "User1", "role": "Participant"}},
            "sessions": {
                session_id: {
                    "transcript": transcript,
                    "last_llm_processed_message_count": last_processed,
                }
            },
        }
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class RunInvokeJobTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _llm_processing_locks.clear()
        self.store = _install_mock_db(self)

    async def _run_with_mocked_orchestrate(
        self,
        agent_result: AgentResult,
        room_id: str = "r1",
        session_id: str = "s1",
        job_id: str = "job-1",
        user_msg_count: int = 5,
        last_processed: int = 0,
    ):
        _seed_session(self.store, room_id, session_id, user_msg_count, last_processed)
        # 初期 job レコード
        main.db.reference(f"rooms/{room_id}/jobs/{job_id}").set({
            "jobId": job_id,
            "sessionId": session_id,
            "status": "queued",
            "createdAt": "2026-04-27T00:00:00Z",
        })

        async def fake_orchestrate(*args, **kwargs):
            return agent_result

        with patch.object(main, "orchestrate_agents", new=fake_orchestrate):
            await _run_invoke_job(
                room_id=room_id,
                session_id=session_id,
                job_id=job_id,
                request_id="req-1",
                task_payload=_make_payload(room_id, session_id),
            )

    async def test_happy_path_transitions_to_done(self):
        await self._run_with_mocked_orchestrate(
            AgentResult(invokedAgents=["TaskManagementAgent"]),
            user_msg_count=5,
            last_processed=0,
        )
        job = self.store["rooms"]["r1"]["jobs"]["job-1"]
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["invokedAgents"], ["TaskManagementAgent"])
        self.assertIn("startedAt", job)
        self.assertIn("completedAt", job)

    async def test_last_processed_count_updated_after_orchestrate(self):
        await self._run_with_mocked_orchestrate(
            AgentResult(invokedAgents=["TaskManagementAgent"]),
            user_msg_count=5,
            last_processed=0,
        )
        session = self.store["rooms"]["r1"]["sessions"]["s1"]
        # 5 件処理済になったことが last_processed に反映される
        self.assertEqual(session["last_llm_processed_message_count"], 5)
        # is_llm_processing は finally で False に戻る
        self.assertEqual(session.get("is_llm_processing"), False)

    async def test_threshold_not_met_finishes_as_noop(self):
        # last_processed=5、current=5 → delta=0 で閾値未達
        await self._run_with_mocked_orchestrate(
            AgentResult(invokedAgents=["TaskManagementAgent"]),
            user_msg_count=5,
            last_processed=5,
        )
        job = self.store["rooms"]["r1"]["jobs"]["job-1"]
        self.assertEqual(job["status"], "done")
        self.assertEqual(job["invokedAgents"], [])

    async def test_error_path_marks_error_and_releases_flag(self):
        _seed_session(self.store, "r1", "s1", user_msg_count=5)
        main.db.reference("rooms/r1/jobs/job-err").set({
            "jobId": "job-err", "sessionId": "s1", "status": "queued",
            "createdAt": "2026-04-27T00:00:00Z",
        })

        async def boom(*args, **kwargs):
            raise RuntimeError("boom")

        with patch.object(main, "orchestrate_agents", new=boom):
            await _run_invoke_job(
                room_id="r1", session_id="s1", job_id="job-err",
                request_id="req-1", task_payload=_make_payload(),
            )

        job = self.store["rooms"]["r1"]["jobs"]["job-err"]
        self.assertEqual(job["status"], "error")
        self.assertIn("error", job)
        self.assertIn("boom", job["error"]["message"])
        # is_llm_processing は finally で False
        session = self.store["rooms"]["r1"]["sessions"]["s1"]
        self.assertEqual(session.get("is_llm_processing"), False)

    async def test_two_concurrent_invokes_serialize_via_lock(self):
        """同一セッションで 2 つの _run_invoke_job が走る → ロックで順次実行されて両方 done"""
        _seed_session(self.store, "r1", "s1", user_msg_count=10, last_processed=0)
        main.db.reference("rooms/r1/jobs/job-A").set({
            "jobId": "job-A", "sessionId": "s1", "status": "queued",
            "createdAt": "2026-04-27T00:00:00Z",
        })
        main.db.reference("rooms/r1/jobs/job-B").set({
            "jobId": "job-B", "sessionId": "s1", "status": "queued",
            "createdAt": "2026-04-27T00:00:00Z",
        })

        execution_order = []

        async def fake_orchestrate(*args, **kwargs):
            jid = kwargs.get("job_id")
            execution_order.append(f"start:{jid}")
            await asyncio.sleep(0.05)
            execution_order.append(f"end:{jid}")
            return AgentResult(invokedAgents=["TaskManagementAgent"])

        with patch.object(main, "orchestrate_agents", new=fake_orchestrate):
            t1 = asyncio.create_task(_run_invoke_job(
                room_id="r1", session_id="s1", job_id="job-A",
                request_id="req-A", task_payload=_make_payload(),
            ))
            await asyncio.sleep(0.005)
            t2 = asyncio.create_task(_run_invoke_job(
                room_id="r1", session_id="s1", job_id="job-B",
                request_id="req-B", task_payload=_make_payload(),
            ))
            await asyncio.gather(t1, t2)

        # 両方とも done
        self.assertEqual(self.store["rooms"]["r1"]["jobs"]["job-A"]["status"], "done")
        self.assertEqual(self.store["rooms"]["r1"]["jobs"]["job-B"]["status"], "done")
        # 順次実行: A 開始 → A 終了 → B 開始 (キュー化)
        # ただし B は閾値未達で no-op になる可能性があるので、orchestrate 呼び出し順だけ確認
        self.assertIn("start:job-A", execution_order)
        a_end = execution_order.index("end:job-A")
        # B は A 終了前には開始しない
        if "start:job-B" in execution_order:
            b_start = execution_order.index("start:job-B")
            self.assertLess(a_end, b_start)


class PurgeJobsTests(unittest.TestCase):
    def setUp(self):
        self.store = _install_mock_db(self)

    def test_purge_old_jobs_only_terminal_and_old(self):
        old_iso = (datetime.utcnow() - timedelta(seconds=3600)).isoformat()
        recent_iso = datetime.utcnow().isoformat()
        self.store["rooms"] = {
            "r1": {
                "jobs": {
                    "j-old-done": {"status": "done", "completedAt": old_iso},
                    "j-old-error": {"status": "error", "completedAt": old_iso},
                    "j-recent-done": {"status": "done", "completedAt": recent_iso},
                    "j-old-running": {"status": "running", "completedAt": old_iso},
                    "j-old-queued": {"status": "queued", "completedAt": old_iso},
                }
            }
        }

        deleted = _purge_old_jobs("r1", max_age_seconds=60)
        self.assertEqual(deleted, 2)  # done + error の old のみ
        remaining = set(self.store["rooms"]["r1"]["jobs"].keys())
        self.assertEqual(remaining, {"j-recent-done", "j-old-running", "j-old-queued"})

    def test_purge_session_jobs_matches_session_only(self):
        self.store["rooms"] = {
            "r1": {
                "jobs": {
                    "j-A": {"sessionId": "s1", "status": "done"},
                    "j-B": {"sessionId": "s2", "status": "done"},
                    "j-C": {"sessionId": "s1", "status": "running"},
                }
            }
        }
        deleted = _purge_session_jobs("r1", "s1")
        self.assertEqual(deleted, 2)
        remaining = set(self.store["rooms"]["r1"]["jobs"].keys())
        self.assertEqual(remaining, {"j-B"})

    def test_purge_room_jobs_deletes_all(self):
        self.store["rooms"] = {
            "r1": {"jobs": {"a": {}, "b": {}, "c": {}}}
        }
        _purge_room_jobs("r1")
        # jobs ノードが消える (空 dict ではなくキー自体が削除される)
        self.assertNotIn("jobs", self.store["rooms"]["r1"])

    def test_recover_stale_jobs_marks_running_and_queued_as_error(self):
        self.store["rooms"] = {
            "r1": {
                "jobs": {
                    "j-running": {"status": "running"},
                    "j-queued": {"status": "queued"},
                    "j-done": {"status": "done"},
                    "j-error": {"status": "error"},
                }
            }
        }
        recovered = _recover_stale_jobs()
        self.assertEqual(recovered, 2)
        self.assertEqual(self.store["rooms"]["r1"]["jobs"]["j-running"]["status"], "error")
        self.assertEqual(self.store["rooms"]["r1"]["jobs"]["j-queued"]["status"], "error")
        self.assertEqual(
            self.store["rooms"]["r1"]["jobs"]["j-running"]["error"]["message"],
            "stale_after_restart",
        )
        # done / error は変更されない
        self.assertEqual(self.store["rooms"]["r1"]["jobs"]["j-done"]["status"], "done")


if __name__ == "__main__":
    unittest.main()
