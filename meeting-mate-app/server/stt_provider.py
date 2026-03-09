"""
STT (Speech-to-Text) プロバイダー抽象レイヤー
OpenAI Whisper / Google Cloud Speech-to-Text に対応
話者分離 (Speaker Diarization) は Google Cloud Speech-to-Text v2 で対応
"""

import io
import logging
from typing import Optional, List, Dict, Any

logger = logging.getLogger(__name__)


class STTProvider:
    """複数プロバイダーに対応したSTTクラス"""

    @staticmethod
    async def transcribe(
        audio_data: bytes,
        provider: str,
        api_key: str,
        language: str = "ja",
        mime_type: str = "audio/webm",
    ) -> str:
        """
        音声データをテキストに変換する。

        Args:
            audio_data: 音声バイナリデータ
            provider: STTプロバイダー名 ("openai" or "google")
            api_key: プロバイダーのAPIキー
            language: 言語コード (例: "ja", "en")
            mime_type: 音声のMIMEタイプ (例: "audio/webm", "audio/wav")

        Returns:
            文字起こしテキスト
        """
        if provider == "openai":
            return await STTProvider._transcribe_openai(audio_data, api_key, language, mime_type)
        elif provider == "google":
            return await STTProvider._transcribe_google(audio_data, api_key, language, mime_type)
        else:
            raise ValueError(f"Unsupported STT provider: {provider}")

    @staticmethod
    async def _transcribe_openai(
        audio_data: bytes,
        api_key: str,
        language: str,
        mime_type: str,
    ) -> str:
        """OpenAI Whisper API による文字起こし"""
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=api_key)

        # MIMEタイプから拡張子を推定
        ext_map = {
            "audio/webm": "webm",
            "audio/wav": "wav",
            "audio/wave": "wav",
            "audio/mp3": "mp3",
            "audio/mpeg": "mp3",
            "audio/mp4": "mp4",
            "audio/m4a": "m4a",
            "audio/ogg": "ogg",
            "audio/flac": "flac",
        }
        ext = ext_map.get(mime_type, "webm")
        filename = f"audio.{ext}"

        audio_file = io.BytesIO(audio_data)
        audio_file.name = filename

        logger.info(f"OpenAI Whisper transcription: language={language}, mime_type={mime_type}")

        response = await client.audio.transcriptions.create(
            model="whisper-1",
            file=audio_file,
            language=language[:2],  # ISO 639-1 (2文字)
            response_format="text",
        )

        result = response.strip() if isinstance(response, str) else str(response).strip()
        logger.info(f"OpenAI Whisper result length: {len(result)} chars")
        return result

    @staticmethod
    async def _transcribe_google(
        audio_data: bytes,
        api_key: str,
        language: str,
        mime_type: str,
    ) -> str:
        """Google Cloud Speech-to-Text API による文字起こし (REST API)"""
        import aiohttp

        # 言語コードマッピング (BCP-47)
        lang_map = {
            "ja": "ja-JP",
            "en": "en-US",
            "zh": "zh-CN",
            "ko": "ko-KR",
            "fr": "fr-FR",
            "de": "de-DE",
            "es": "es-ES",
        }
        bcp47_lang = lang_map.get(language[:2], f"{language[:2]}-{language[:2].upper()}")

        # MIMEタイプからエンコーディングを推定
        encoding_map = {
            "audio/webm": "WEBM_OPUS",
            "audio/ogg": "OGG_OPUS",
            "audio/flac": "FLAC",
            "audio/wav": "LINEAR16",
            "audio/wave": "LINEAR16",
            "audio/mp3": "MP3",
            "audio/mpeg": "MP3",
        }
        encoding = encoding_map.get(mime_type, "WEBM_OPUS")

        import base64
        audio_b64 = base64.b64encode(audio_data).decode("utf-8")

        request_body = {
            "config": {
                "encoding": encoding,
                "languageCode": bcp47_lang,
                "enableAutomaticPunctuation": True,
            },
            "audio": {
                "content": audio_b64,
            },
        }

        url = f"https://speech.googleapis.com/v1/speech:recognize?key={api_key}"

        logger.info(f"Google STT: language={bcp47_lang}, encoding={encoding}")

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=request_body) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    raise RuntimeError(f"Google STT API error ({resp.status}): {error_text}")

                result = await resp.json()

        # レスポンスからテキストを抽出
        results = result.get("results", [])
        if not results:
            logger.warning("Google STT returned no results")
            return ""

        transcript_parts = []
        for r in results:
            alternatives = r.get("alternatives", [])
            if alternatives:
                transcript_parts.append(alternatives[0].get("transcript", ""))

        transcript = " ".join(transcript_parts).strip()
        logger.info(f"Google STT result length: {len(transcript)} chars")
        return transcript

    # ================================================================
    # 話者分離 (Speaker Diarization) — Google Cloud Speech-to-Text v2
    # ================================================================

    @staticmethod
    def _get_bcp47(language: str) -> str:
        """言語コードを BCP-47 形式に変換"""
        lang_map = {
            "ja": "ja-JP",
            "en": "en-US",
            "zh": "zh-CN",
            "ko": "ko-KR",
            "fr": "fr-FR",
            "de": "de-DE",
            "es": "es-ES",
        }
        return lang_map.get(language[:2], f"{language[:2]}-{language[:2].upper()}")

    @staticmethod
    async def transcribe_with_diarization(
        audio_data: bytes,
        credentials_path: str,
        language: str = "ja",
        mime_type: str = "audio/webm",
        min_speakers: int = 2,
        max_speakers: int = 6,
    ) -> Dict[str, Any]:
        """
        話者分離付き文字起こし (Google Cloud Speech-to-Text v2)

        Returns:
            {
                "text": "全体テキスト",
                "segments": [{"speaker_tag": 1, "text": "...", "start_time": 0.0, "end_time": 1.5}, ...],
                "provider": "google_v2_diarized"
            }
        """
        return await STTProvider._transcribe_google_v2_diarized(
            audio_data, credentials_path, language, mime_type,
            min_speakers, max_speakers
        )

    @staticmethod
    async def _transcribe_google_v2_diarized(
        audio_data: bytes,
        credentials_path: str,
        language: str,
        mime_type: str,
        min_speakers: int,
        max_speakers: int,
    ) -> Dict[str, Any]:
        """Google Cloud Speech-to-Text v2 API による話者分離付き文字起こし"""
        import asyncio
        from google.cloud.speech_v2 import SpeechClient
        from google.cloud.speech_v2.types import cloud_speech as types
        from google.oauth2 import service_account

        # Service Account 認証
        creds = service_account.Credentials.from_service_account_file(
            credentials_path
        )
        project_id = creds.project_id

        bcp47_lang = STTProvider._get_bcp47(language)

        logger.info(
            f"Google STT v2 diarized: language={bcp47_lang}, "
            f"speakers={min_speakers}-{max_speakers}, "
            f"audio_size={len(audio_data)} bytes"
        )

        # 話者分離設定
        diarization_config = types.SpeakerDiarizationConfig(
            min_speaker_count=min_speakers,
            max_speaker_count=min(max_speakers, 6),
        )

        features = types.RecognitionFeatures(
            diarization_config=diarization_config,
            enable_automatic_punctuation=True,
            enable_word_time_offsets=True,
        )

        config = types.RecognitionConfig(
            auto_decoding_config=types.AutoDetectDecodingConfig(),
            language_codes=[bcp47_lang],
            model="long",
            features=features,
        )

        request = types.RecognizeRequest(
            recognizer=f"projects/{project_id}/locations/global/recognizers/_",
            config=config,
            content=audio_data,
        )

        # 同期 API を asyncio で非同期実行
        loop = asyncio.get_event_loop()
        client = SpeechClient(credentials=creds)
        response = await loop.run_in_executor(None, client.recognize, request)

        # レスポンスから話者別セグメントを構築
        segments: List[Dict[str, Any]] = []
        full_text_parts: List[str] = []

        for result in response.results:
            if not result.alternatives:
                continue
            alt = result.alternatives[0]
            full_text_parts.append(alt.transcript)

            # words に speaker_tag が含まれる
            if not alt.words:
                continue

            current_speaker: Optional[int] = None
            current_words: List[str] = []
            current_start: Optional[float] = None

            for word_info in alt.words:
                tag = word_info.speaker_tag
                word_start = word_info.start_offset.total_seconds() if word_info.start_offset else 0.0
                word_end = word_info.end_offset.total_seconds() if word_info.end_offset else 0.0

                if tag != current_speaker:
                    # 話者が変わった → 前のセグメントを保存
                    if current_speaker is not None and current_words:
                        segments.append({
                            "speaker_tag": current_speaker,
                            "text": "".join(current_words),
                            "start_time": current_start,
                            "end_time": word_start,
                        })
                    current_speaker = tag
                    current_words = [word_info.word]
                    current_start = word_start
                else:
                    current_words.append(word_info.word)

            # 最後のセグメント
            if current_speaker is not None and current_words:
                last_end = alt.words[-1].end_offset.total_seconds() if alt.words[-1].end_offset else 0.0
                segments.append({
                    "speaker_tag": current_speaker,
                    "text": "".join(current_words),
                    "start_time": current_start,
                    "end_time": last_end,
                })

        full_text = "".join(full_text_parts).strip()
        logger.info(
            f"Google STT v2 diarized result: {len(full_text)} chars, "
            f"{len(segments)} segments"
        )

        return {
            "text": full_text,
            "segments": segments,
            "provider": "google_v2_diarized",
        }
