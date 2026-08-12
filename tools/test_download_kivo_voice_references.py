from __future__ import annotations

from pathlib import Path
import sys
import unittest

if __package__:
    from tools.download_kivo_voice_references import (
        CHARACTERS,
        KivoVoiceReferenceError,
        ReferenceVoice,
        build_agent_paths,
        content_addressed_reference_file,
        merge_voice_profile,
        normalize_kivo_audio_url,
        select_reference_voice,
        _timestamp_now,
    )
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from download_kivo_voice_references import (  # type: ignore[no-redef]
        CHARACTERS,
        KivoVoiceReferenceError,
        ReferenceVoice,
        build_agent_paths,
        content_addressed_reference_file,
        merge_voice_profile,
        normalize_kivo_audio_url,
        select_reference_voice,
        _timestamp_now,
    )


def voice(text: str, file_name: str, category: str) -> dict[str, str]:
    return {
        "text_original": text,
        "file": f"//static.kivo.wiki/voices/{file_name}.ogg",
        "category": category,
        "description": f"{category} sample",
    }


class NormalizeKivoAudioUrlTests(unittest.TestCase):
    def test_normalizes_protocol_relative_voice_url(self) -> None:
        self.assertEqual(
            normalize_kivo_audio_url("//static.kivo.wiki/voices/arona/sample.ogg"),
            "https://static.kivo.wiki/voices/arona/sample.ogg",
        )

    def test_rejects_unapproved_audio_urls(self) -> None:
        invalid_urls = (
            "http://static.kivo.wiki/voices/sample.ogg",
            "https://example.com/voices/sample.ogg",
            "https://user:pass@static.kivo.wiki/voices/sample.ogg",
            "https://static.kivo.wiki/assets/sample.ogg",
            "https://static.kivo.wiki:8443/voices/sample.ogg",
        )
        for invalid_url in invalid_urls:
            with self.subTest(url=invalid_url):
                with self.assertRaises(KivoVoiceReferenceError):
                    normalize_kivo_audio_url(invalid_url)

    def test_runtime_timestamp_uses_canonical_milliseconds(self) -> None:
        self.assertRegex(
            _timestamp_now(),
            r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$",
        )


class SelectReferenceVoiceTests(unittest.TestCase):
    def test_prefers_moderate_japanese_lobby_line(self) -> None:
        payload = {
            "data": {
                "voice": [
                    voice("这是一条只有中文的大厅语音，不应被选中。", "zh", "Lobby"),
                    voice("おはようございます。今日も一緒に頑張りましょうね。", "event", "Event"),
                    voice("先生、おかえりなさい。今日も会えて本当にうれしいです。", "lobby", "Lobby"),
                    voice("ログインしました。", "login", "Login"),
                ]
            }
        }

        selected = select_reference_voice(payload)

        self.assertEqual(selected.category, "Lobby")
        self.assertIn("おかえりなさい", selected.text)
        self.assertEqual(selected.source_index, 2)

    def test_uses_non_moderate_fallback_when_needed(self) -> None:
        payload = {
            "data": {
                "voice": [
                    voice("はい。", "short-other", "Battle"),
                    voice("おはよう。", "short-event", "Event"),
                ]
            }
        }

        selected = select_reference_voice(payload)

        self.assertEqual(selected.category, "Event")
        self.assertEqual(selected.text, "おはよう。")

    def test_raises_when_no_usable_japanese_voice_exists(self) -> None:
        payload = {"data": {"voice": [voice("早上好。", "zh", "Lobby")]}}

        with self.assertRaises(KivoVoiceReferenceError):
            select_reference_voice(payload)


class MergeVoiceProfileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.candidate = ReferenceVoice(
            text="先生、おかえりなさい。",
            source_url="https://static.kivo.wiki/voices/arona/sample.ogg",
            category="Lobby",
            description="Lobby sample",
            source_index=3,
        )

    def test_emits_exact_profile_and_preserves_only_canonical_zh_en(self) -> None:
        existing_en = {
            "language": "en",
            "fileName": "existing-en.wav",
            "relativePath": f"voice/references/existing-en-{'c' * 64}.wav",
            "mimeType": "audio/wav",
            "sizeBytes": 321,
            "sha256": "c" * 64,
            "referenceText": "Existing English reference.",
            "sourceUrl": "https://example.com/existing-en.wav",
            "characterUrl": "https://example.com/character",
            "updatedAt": "2026-07-18T00:00:00Z",
            "unknownLanguageField": "drop-me",
        }
        existing = {
            "schemaVersion": 0,
            "enabled": False,
            "defaultLanguage": "en",
            "customTopLevel": {"drop": True},
            "languages": {
                "zh": None,
                "en": existing_en,
                "ko": {"language": "ko", "drop": True},
                "ja": {
                    "unknownJaField": "drop-ja",
                    "sourceUrl": "https://old.invalid/reference.ogg",
                },
            },
        }

        merged = merge_voice_profile(
            existing,
            candidate=self.candidate,
            character=CHARACTERS["arona"],
            sha256="a" * 64,
            size_bytes=12345,
            updated_at="2026-07-19T00:00:00Z",
        )

        self.assertEqual(merged["schemaVersion"], 1)
        self.assertIs(merged["enabled"], True)
        self.assertEqual(merged["defaultLanguage"], "ja")
        self.assertEqual(
            set(merged), {"schemaVersion", "enabled", "defaultLanguage", "languages"}
        )
        self.assertEqual(set(merged["languages"]), {"zh", "en", "ja"})
        self.assertIsNone(merged["languages"]["zh"])
        self.assertEqual(
            set(merged["languages"]["en"]),
            {
                "language",
                "fileName",
                "relativePath",
                "mimeType",
                "sizeBytes",
                "sha256",
                "referenceText",
                "sourceUrl",
                "characterUrl",
                "updatedAt",
            },
        )
        self.assertNotIn("unknownLanguageField", merged["languages"]["en"])

        ja = merged["languages"]["ja"]
        self.assertEqual(ja["language"], "ja")
        self.assertEqual(ja["fileName"], "kivo-ja.wav")
        self.assertEqual(
            ja["relativePath"], f"voice/references/kivo-ja-{'a' * 64}.wav"
        )
        self.assertEqual(ja["mimeType"], "audio/wav")
        self.assertEqual(ja["sizeBytes"], 12345)
        self.assertEqual(ja["sha256"], "a" * 64)
        self.assertEqual(ja["referenceText"], self.candidate.text)
        self.assertEqual(ja["sourceUrl"], self.candidate.source_url)
        self.assertEqual(ja["characterUrl"], "https://kivo.wiki/data/character/104")
        self.assertEqual(ja["updatedAt"], "2026-07-19T00:00:00Z")
        self.assertNotIn("unknownJaField", ja)
        self.assertNotIn("size", ja)

    def test_builds_new_contract_with_null_zh_and_en(self) -> None:
        merged = merge_voice_profile(
            {},
            candidate=self.candidate,
            character=CHARACTERS["plana"],
            sha256="b" * 64,
            size_bytes=678,
            updated_at="2026-07-19T01:02:03Z",
        )

        self.assertEqual(
            set(merged), {"schemaVersion", "enabled", "defaultLanguage", "languages"}
        )
        self.assertIsNone(merged["languages"]["zh"])
        self.assertIsNone(merged["languages"]["en"])
        self.assertNotIn("size", merged["languages"]["ja"])
        self.assertEqual(merged["languages"]["ja"]["sizeBytes"], 678)


class AgentPathsTests(unittest.TestCase):
    def test_builds_expected_agent_voice_paths(self) -> None:
        workspace = Path("/tmp/sunabot-workspace")

        paths = build_agent_paths(workspace, "koharu")

        self.assertEqual(
            content_addressed_reference_file(paths, "d" * 64),
            workspace.resolve()
            / "business/agents/koharu/voice/references"
            / f"kivo-ja-{'d' * 64}.wav",
        )
        self.assertEqual(
            paths.profile_file,
            workspace.resolve() / "business/agents/koharu/voice/profile.json",
        )

    def test_rejects_non_sha_content_address(self) -> None:
        paths = build_agent_paths(Path("/tmp/sunabot-workspace"), "arona")

        with self.assertRaises(KivoVoiceReferenceError):
            content_addressed_reference_file(paths, "not-a-sha256")


if __name__ == "__main__":
    unittest.main()
