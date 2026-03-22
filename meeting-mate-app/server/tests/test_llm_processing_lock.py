"""Issue #21: is_llm_processing の競合制御テスト"""
import asyncio
import os
import sys
import unittest

SERVER_DIR = os.path.dirname(os.path.dirname(__file__))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

from main import _get_processing_lock, _llm_processing_locks  # noqa: E402


class GetProcessingLockTests(unittest.TestCase):
    def setUp(self):
        _llm_processing_locks.clear()

    def test_same_path_returns_same_lock(self):
        lock1 = _get_processing_lock("rooms/r1/sessions/s1")
        lock2 = _get_processing_lock("rooms/r1/sessions/s1")
        self.assertIs(lock1, lock2)

    def test_different_paths_return_different_locks(self):
        lock1 = _get_processing_lock("rooms/r1/sessions/s1")
        lock2 = _get_processing_lock("rooms/r1/sessions/s2")
        self.assertIsNot(lock1, lock2)

    def test_lock_is_asyncio_lock(self):
        lock = _get_processing_lock("rooms/r1/sessions/s1")
        self.assertIsInstance(lock, asyncio.Lock)


class LockExclusionTests(unittest.TestCase):
    """ロックによる排他制御の統合テスト"""

    def setUp(self):
        _llm_processing_locks.clear()

    def test_same_session_exclusive(self):
        """同一セッションの同時呼び出し → 最初のみ処理、後続は skip"""
        path = "rooms/r1/sessions/s1"
        lock = _get_processing_lock(path)
        execution_log = []

        async def worker(worker_id: str, delay: float):
            if lock.locked():
                execution_log.append(f"{worker_id}:skipped")
                return
            async with lock:
                execution_log.append(f"{worker_id}:acquired")
                await asyncio.sleep(delay)
                execution_log.append(f"{worker_id}:released")

        async def run():
            # worker1 がロック取得後、worker2 は locked() で skip
            t1 = asyncio.create_task(worker("w1", 0.1))
            await asyncio.sleep(0.01)  # w1 がロック取得する時間を確保
            t2 = asyncio.create_task(worker("w2", 0.0))
            await asyncio.gather(t1, t2)

        asyncio.run(run())
        self.assertIn("w1:acquired", execution_log)
        self.assertIn("w1:released", execution_log)
        self.assertIn("w2:skipped", execution_log)
        self.assertNotIn("w2:acquired", execution_log)

    def test_different_sessions_parallel(self):
        """異なるセッション → 並列実行可能"""
        execution_log = []

        async def worker(path: str, worker_id: str):
            lock = _get_processing_lock(path)
            async with lock:
                execution_log.append(f"{worker_id}:acquired")
                await asyncio.sleep(0.05)
                execution_log.append(f"{worker_id}:released")

        async def run():
            t1 = asyncio.create_task(worker("rooms/r1/sessions/s1", "w1"))
            t2 = asyncio.create_task(worker("rooms/r1/sessions/s2", "w2"))
            await asyncio.gather(t1, t2)

        asyncio.run(run())
        # 両方とも acquired されること
        self.assertIn("w1:acquired", execution_log)
        self.assertIn("w2:acquired", execution_log)
        # w2 は w1 の完了を待たずに開始できる（並列）
        _ = execution_log.index("w1:acquired")
        w2_acquired_idx = execution_log.index("w2:acquired")
        w1_released_idx = execution_log.index("w1:released")
        # w2 は w1 が release する前に acquire できる
        self.assertLess(w2_acquired_idx, w1_released_idx)

    def test_lock_released_after_exception(self):
        """例外発生時もロックが解放される"""
        path = "rooms/r1/sessions/s1"
        lock = _get_processing_lock(path)

        async def failing_worker():
            async with lock:
                raise RuntimeError("test error")

        async def run():
            with self.assertRaises(RuntimeError):
                await failing_worker()
            # 例外後にロックが解放されていること
            self.assertFalse(lock.locked())

        asyncio.run(run())

    def test_vision_trylock_skips_when_invoke_holds_lock(self):
        """/invoke がロック保持中に vision トリガ → vision は skip"""
        path = "rooms/r1/sessions/s1"
        lock = _get_processing_lock(path)
        vision_results = []

        async def invoke_simulation():
            async with lock:
                await asyncio.sleep(0.1)

        async def vision_simulation():
            if lock.locked():
                vision_results.append("skipped")
                return
            async with lock:
                vision_results.append("executed")

        async def run():
            invoke_task = asyncio.create_task(invoke_simulation())
            await asyncio.sleep(0.01)  # invoke がロック取得する時間を確保
            vision_task = asyncio.create_task(vision_simulation())
            await asyncio.gather(invoke_task, vision_task)

        asyncio.run(run())
        self.assertEqual(vision_results, ["skipped"])

    def test_vision_multiple_triggers_only_one_executes(self):
        """vision 多重トリガ → 1回だけ実行される"""
        path = "rooms/r1/sessions/s1"
        lock = _get_processing_lock(path)
        execution_count = []

        async def vision_trigger(trigger_id: int, hold_time: float):
            if lock.locked():
                return  # skip
            async with lock:
                execution_count.append(trigger_id)
                await asyncio.sleep(hold_time)

        async def run():
            t1 = asyncio.create_task(vision_trigger(1, 0.1))
            await asyncio.sleep(0.01)
            # t1 がロック保持中に t2, t3 をトリガ
            t2 = asyncio.create_task(vision_trigger(2, 0.0))
            t3 = asyncio.create_task(vision_trigger(3, 0.0))
            await asyncio.gather(t1, t2, t3)

        asyncio.run(run())
        self.assertEqual(len(execution_count), 1)
        self.assertEqual(execution_count[0], 1)


if __name__ == "__main__":
    unittest.main()
