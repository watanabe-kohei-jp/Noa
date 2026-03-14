"""
TTS (Text-to-Speech) プロバイダー抽象レイヤー
OpenAI TTS / Google Cloud Text-to-Speech に対応
"""

import logging

logger = logging.getLogger(__name__)


class TTSProvider:
    """複数プロバイダーに対応したTTSクラス"""

    @staticmethod
    async def synthesize(
        text: str,
        provider: str,
        api_key: str,
        language: str = "ja",
        voice: str = "alloy",
    ) -> bytes:
        """
        テキストを音声データ (MP3) に変換する。

        Args:
            text: 読み上げるテキスト
            provider: TTSプロバイダー名 ("openai" or "google")
            api_key: プロバイダーのAPIキー
            language: 言語コード (例: "ja", "en")
            voice: 音声名 (プロバイダー依存)

        Returns:
            MP3音声バイナリデータ
        """
        if provider == "openai":
            return await TTSProvider._synthesize_openai(text, api_key, voice)
        elif provider == "google":
            return await TTSProvider._synthesize_google(text, api_key, language, voice)
        else:
            raise ValueError(f"Unsupported TTS provider: {provider}")

    @staticmethod
    async def _synthesize_openai(
        text: str,
        api_key: str,
        voice: str,
    ) -> bytes:
        """OpenAI TTS API による音声合成"""
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=api_key)

        # OpenAI TTS で使えるボイス: alloy, echo, fable, onyx, nova, shimmer
        valid_voices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"]
        if voice not in valid_voices:
            logger.warning(f"Unknown OpenAI voice '{voice}', falling back to 'alloy'")
            voice = "alloy"

        logger.info(f"OpenAI TTS: voice={voice}, text_length={len(text)}")

        response = await client.audio.speech.create(
            model="tts-1",
            voice=voice,
            input=text,
            response_format="mp3",
        )

        audio_bytes = response.content
        logger.info(f"OpenAI TTS result: {len(audio_bytes)} bytes")
        return audio_bytes

    @staticmethod
    async def _synthesize_google(
        text: str,
        api_key: str,
        language: str,
        voice: str,
    ) -> bytes:
        """Google Cloud Text-to-Speech API による音声合成 (REST API)"""
        import aiohttp
        import base64

        # 言語コードマッピング
        lang_map = {
            "ja": "ja-JP",
            "en": "en-US",
            "zh": "cmn-CN",
            "ko": "ko-KR",
            "fr": "fr-FR",
            "de": "de-DE",
            "es": "es-ES",
        }
        bcp47_lang = lang_map.get(language[:2], f"{language[:2]}-{language[:2].upper()}")

        # Google TTS ボイス名のデフォルトマッピング
        voice_map = {
            "ja-JP": "ja-JP-Neural2-B",
            "en-US": "en-US-Neural2-A",
            "cmn-CN": "cmn-CN-Wavenet-A",
            "ko-KR": "ko-KR-Neural2-A",
            "fr-FR": "fr-FR-Neural2-A",
            "de-DE": "de-DE-Neural2-A",
            "es-ES": "es-ES-Neural2-A",
        }

        # ユーザー指定のボイスがGoogle形式でなければデフォルトを使う
        if not voice.startswith(bcp47_lang):
            google_voice = voice_map.get(bcp47_lang, f"{bcp47_lang}-Standard-A")
        else:
            google_voice = voice

        request_body = {
            "input": {"text": text},
            "voice": {
                "languageCode": bcp47_lang,
                "name": google_voice,
            },
            "audioConfig": {
                "audioEncoding": "MP3",
                "speakingRate": 1.0,
                "pitch": 0.0,
            },
        }

        url = f"https://texttospeech.googleapis.com/v1/text:synthesize?key={api_key}"

        logger.info(f"Google TTS: voice={google_voice}, language={bcp47_lang}, text_length={len(text)}")

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=request_body) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    raise RuntimeError(f"Google TTS API error ({resp.status}): {error_text}")

                result = await resp.json()

        audio_b64 = result.get("audioContent", "")
        if not audio_b64:
            raise RuntimeError("Google TTS returned no audio content")

        audio_bytes = base64.b64decode(audio_b64)
        logger.info(f"Google TTS result: {len(audio_bytes)} bytes")
        return audio_bytes
