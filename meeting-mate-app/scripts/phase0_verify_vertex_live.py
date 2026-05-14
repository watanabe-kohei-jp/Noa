"""Issue #139 Phase 0 必須ゲート検証スクリプト.

Vertex AI Live API への ADC 接続と日本→us-central1 レイテンシを実測する。

前提:
    gcloud auth application-default login 済み
    GCP_PROJECT_ID 環境変数 (or `gcloud config set project <id>` 済み)
    pip install google-genai

実行:
    cd meeting-mate-app
    python scripts/phase0_verify_vertex_live.py

検証項目:
    1. Vertex AI で Live モデル ID が実機接続できる (GA / preview の両方を試行)
    2. setupComplete までの TTFT を 100 サンプル測定
    3. ADC 経由でキー無し接続できる
"""
from __future__ import annotations

import asyncio
import os
import statistics
import sys
import time
from contextlib import suppress

from google import genai
from google.genai import types

MODELS_TO_TRY = [
    "gemini-live-2.5-flash-native-audio",
    "gemini-live-2.5-flash-preview-native-audio-09-2025",
    # AI Studio 系も比較用に残す (Vertex で通らないはず)
    "gemini-2.5-flash-native-audio-preview-12-2025",
]
LOCATION = os.environ.get("GCP_LOCATION", "us-central1")
PROJECT_ID = os.environ.get("GCP_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT")
SAMPLES = int(os.environ.get("SAMPLES", "10"))


async def measure_ttft(client: genai.Client, model: str) -> float:
    """setup → setupComplete までの秒数を返す."""
    config = types.LiveConnectConfig(response_modalities=["AUDIO"])
    t0 = time.perf_counter()
    async with client.aio.live.connect(model=model, config=config) as session:
        async for message in session.receive():
            if message.setup_complete is not None:
                break
    return time.perf_counter() - t0


async def try_model(client: genai.Client, model: str) -> dict:
    print(f"\n=== {model} ===")
    try:
        first = await measure_ttft(client, model)
        print(f"  initial connect OK: {first*1000:.0f}ms")
    except Exception as exc:  # noqa: BLE001
        print(f"  initial connect FAILED: {type(exc).__name__}: {exc}")
        return {"model": model, "ok": False, "error": str(exc)}

    samples: list[float] = [first]
    for i in range(SAMPLES - 1):
        with suppress(Exception):
            samples.append(await measure_ttft(client, model))
        await asyncio.sleep(0.5)

    print(f"  samples n={len(samples)}")
    print(f"  median: {statistics.median(samples)*1000:.0f}ms")
    print(f"  p95:    {sorted(samples)[int(len(samples)*0.95)-1]*1000:.0f}ms")
    return {
        "model": model,
        "ok": True,
        "samples": samples,
        "median_ms": statistics.median(samples) * 1000,
    }


async def main() -> int:
    if not PROJECT_ID:
        print("ERROR: set GCP_PROJECT_ID or run 'gcloud config set project <id>'")
        return 1

    print(f"Project: {PROJECT_ID}")
    print(f"Location: {LOCATION}")
    print(f"Samples per model: {SAMPLES}")

    client = genai.Client(
        vertexai=True,
        project=PROJECT_ID,
        location=LOCATION,
    )

    results = []
    for model in MODELS_TO_TRY:
        results.append(await try_model(client, model))

    print("\n=== Summary ===")
    for r in results:
        if r.get("ok"):
            print(f"  ✅ {r['model']}: median {r['median_ms']:.0f}ms")
        else:
            print(f"  ❌ {r['model']}: {r.get('error', 'unknown')}")

    # 1 つでも GA / preview モデルが通れば Phase 0 #1 #5 はクリア
    ok_models = [r for r in results if r.get("ok") and "preview-12-2025" not in r["model"]]
    return 0 if ok_models else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
