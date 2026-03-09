"""
Streaming STT (Speech-to-Text) with Speaker Diarization
Google Cloud Speech-to-Text v1 gRPC Streaming API を使用した
リアルタイム音声認識 + 話者分離セッション管理

v2 API のデフォルト Recognizer は話者分離非対応のため v1 を使用。

WebSocket プロトコル:
  Client → Server:
    { type: "config", language: "ja", minSpeakers: 2, maxSpeakers: 6 }
    { type: "audio", data: "<base64 PCM16>", sampleRate: 16000 }
    { type: "stop" }

  Server → Client:
    { type: "interim", speakerTag: 1, text: "...", startTime: 12.5 }
    { type: "final", speakerTag: 2, text: "...", startTime: 15.0, endTime: 18.3 }
    { type: "error", message: "..." }
    { type: "status", connected: true }
"""

import asyncio
import base64
import logging
import queue
import threading
import time
from typing import Optional, Dict, Any

from google.cloud import speech_v1 as speech
from google.oauth2 import service_account

logger = logging.getLogger(__name__)

# gRPC Streaming は約5分でタイムアウト
GRPC_SESSION_TIMEOUT_SEC = 280  # 余裕を持って4分40秒


class StreamingSTTSession:
    """
    Google Cloud STT v1 gRPC Streaming セッション。

    1つの WebSocket 接続に対して1つのセッションを管理。
    5分タイムアウト時は自動で再接続する。
    """

    def __init__(
        self,
        credentials_path: str,
        language: str = "ja",
        min_speakers: int = 2,
        max_speakers: int = 6,
        sample_rate: int = 16000,
    ):
        self._credentials_path = credentials_path
        self._language = self._get_bcp47(language)
        self._min_speakers = min_speakers
        self._max_speakers = min(max_speakers, 6)
        self._sample_rate = sample_rate

        # Service Account 認証
        self._creds = service_account.Credentials.from_service_account_file(
            credentials_path
        )
        self._project_id = self._creds.project_id

        # スレッド間通信用キュー
        self._audio_queue: queue.Queue = queue.Queue()
        self._results_queue: asyncio.Queue = asyncio.Queue()

        # セッション状態
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._session_start_time: float = 0
        self._event_loop: Optional[asyncio.AbstractEventLoop] = None

        logger.info(
            f"StreamingSTTSession created: project={self._project_id}, "
            f"language={self._language}, speakers={self._min_speakers}-{self._max_speakers}"
        )

    @staticmethod
    def _get_bcp47(language: str) -> str:
        lang_map = {
            "ja": "ja-JP", "en": "en-US", "zh": "zh-CN",
            "ko": "ko-KR", "fr": "fr-FR", "de": "de-DE", "es": "es-ES",
        }
        return lang_map.get(language[:2], f"{language[:2]}-{language[:2].upper()}")

    def _build_streaming_config(self) -> speech.StreamingRecognitionConfig:
        """gRPC Streaming 用の認識設定を構築 (v1 API)"""
        diarization_config = speech.SpeakerDiarizationConfig(
            enable_speaker_diarization=True,
            min_speaker_count=self._min_speakers,
            max_speaker_count=self._max_speakers,
        )

        recognition_config = speech.RecognitionConfig(
            encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
            sample_rate_hertz=self._sample_rate,
            language_code=self._language,
            enable_automatic_punctuation=True,
            enable_word_time_offsets=True,
            model="default",
            diarization_config=diarization_config,
        )

        streaming_config = speech.StreamingRecognitionConfig(
            config=recognition_config,
            interim_results=True,
        )

        return streaming_config

    def _audio_generator(self):
        """音声データのみを yield するジェネレータ (v1 config は別途渡す)"""
        while self._running:
            try:
                audio_data = self._audio_queue.get(timeout=0.1)
                if audio_data is None:  # sentinel
                    break
                yield speech.StreamingRecognizeRequest(audio_content=audio_data)
            except queue.Empty:
                continue

    def _process_response(self, response: speech.StreamingRecognizeResponse):
        """gRPC レスポンスを WebSocket 用 JSON に変換"""
        for result in response.results:
            if not result.alternatives:
                continue

            alt = result.alternatives[0]
            is_final = result.is_final

            # 話者分離情報の抽出
            speaker_tag = 0
            start_time = 0.0
            end_time = 0.0

            if alt.words:
                # 最頻出の speaker_tag を採用
                tags = [w.speaker_tag for w in alt.words if w.speaker_tag > 0]
                if tags:
                    speaker_tag = max(set(tags), key=tags.count)

                first_word = alt.words[0]
                last_word = alt.words[-1]
                if first_word.start_time:
                    start_time = first_word.start_time.total_seconds()
                if last_word.end_time:
                    end_time = last_word.end_time.total_seconds()

            msg = {
                "type": "final" if is_final else "interim",
                "text": alt.transcript.strip(),
                "speakerTag": speaker_tag,
                "startTime": round(start_time, 2),
                "confidence": round(alt.confidence, 3) if alt.confidence else 0.0,
            }

            if is_final:
                msg["endTime"] = round(end_time, 2)

                # final 結果の場合、words から話者別セグメントも構築
                segments = self._build_speaker_segments(alt.words)
                if segments:
                    msg["segments"] = segments

            # asyncio キューに結果を投入
            if self._event_loop and not self._event_loop.is_closed():
                asyncio.run_coroutine_threadsafe(
                    self._results_queue.put(msg), self._event_loop
                )

    def _build_speaker_segments(self, words) -> list:
        """words リストから話者別セグメントを構築"""
        if not words:
            return []

        segments = []
        current_speaker = None
        current_words = []
        current_start = 0.0

        for word_info in words:
            tag = word_info.speaker_tag
            word_start = (
                word_info.start_time.total_seconds()
                if word_info.start_time else 0.0
            )
            word_end = (
                word_info.end_time.total_seconds()
                if word_info.end_time else 0.0
            )

            if tag != current_speaker:
                if current_speaker is not None and current_words:
                    segments.append({
                        "speakerTag": current_speaker,
                        "text": "".join(current_words),
                        "startTime": round(current_start, 2),
                        "endTime": round(word_start, 2),
                    })
                current_speaker = tag
                current_words = [word_info.word]
                current_start = word_start
            else:
                current_words.append(word_info.word)

        # 最後のセグメント
        if current_speaker is not None and current_words:
            last_end = (
                words[-1].end_time.total_seconds()
                if words[-1].end_time else 0.0
            )
            segments.append({
                "speakerTag": current_speaker,
                "text": "".join(current_words),
                "startTime": round(current_start, 2),
                "endTime": round(last_end, 2),
            })

        return segments

    def _streaming_thread(self):
        """gRPC Streaming を実行するワーカースレッド"""
        while self._running:
            try:
                self._session_start_time = time.time()
                client = speech.SpeechClient(credentials=self._creds)

                logger.info("gRPC Streaming session started (v1 API)")

                # status 通知
                if self._event_loop and not self._event_loop.is_closed():
                    asyncio.run_coroutine_threadsafe(
                        self._results_queue.put({
                            "type": "status", "connected": True
                        }),
                        self._event_loop,
                    )

                responses = client.streaming_recognize(
                    config=self._build_streaming_config(),
                    requests=self._audio_generator(),
                )

                for response in responses:
                    if not self._running:
                        break
                    self._process_response(response)

                    # 5分タイムアウト前に再接続
                    elapsed = time.time() - self._session_start_time
                    if elapsed >= GRPC_SESSION_TIMEOUT_SEC:
                        logger.info(
                            f"gRPC session approaching timeout ({elapsed:.0f}s), "
                            "reconnecting..."
                        )
                        break

                logger.info("gRPC Streaming session ended")

            except Exception as e:
                if not self._running:
                    break
                error_msg = str(e)
                logger.error(f"gRPC Streaming error: {error_msg}")
                if self._event_loop and not self._event_loop.is_closed():
                    asyncio.run_coroutine_threadsafe(
                        self._results_queue.put({
                            "type": "error", "message": error_msg
                        }),
                        self._event_loop,
                    )
                # エラー時は少し待ってからリトライ
                if self._running:
                    time.sleep(1)

        # 終了通知
        if self._event_loop and not self._event_loop.is_closed():
            asyncio.run_coroutine_threadsafe(
                self._results_queue.put(None), self._event_loop
            )

    async def start(self):
        """ストリーミングセッションを開始"""
        if self._running:
            logger.warning("Session already running")
            return

        self._running = True
        self._event_loop = asyncio.get_event_loop()

        # gRPC ワーカースレッドを起動
        self._thread = threading.Thread(
            target=self._streaming_thread,
            daemon=True,
            name="grpc-stt-worker",
        )
        self._thread.start()
        logger.info("Streaming STT session started")

    def send_audio(self, audio_bytes: bytes):
        """音声データを gRPC ストリームに送信"""
        if self._running:
            self._audio_queue.put(audio_bytes)

    async def get_result(self) -> Optional[Dict[str, Any]]:
        """次の認識結果を取得 (None = セッション終了)"""
        return await self._results_queue.get()

    async def stop(self):
        """セッションを停止"""
        if not self._running:
            return

        logger.info("Stopping streaming STT session...")
        self._running = False
        # sentinel を送ってジェネレータを停止
        self._audio_queue.put(None)

        # スレッド終了を待つ（asyncio ブロッキング回避）
        if self._thread and self._thread.is_alive():
            await asyncio.get_event_loop().run_in_executor(
                None, self._thread.join, 5.0
            )

        logger.info("Streaming STT session stopped")

    @property
    def is_running(self) -> bool:
        return self._running
