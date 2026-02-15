"""
STT (Speech-to-Text) プロバイダー抽象レイヤー
OpenAI Whisper / Google Cloud Speech-to-Text に対応
"""

import io
import logging
from typing import Optional

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
