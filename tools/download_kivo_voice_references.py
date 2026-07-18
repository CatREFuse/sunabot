#!/usr/bin/env python3
"""Download and prepare a Japanese Kivo reference voice for a Sunabot agent."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen
import wave


API_BASE_URL = "https://api.kivo.wiki/api/v1/data/students"
KIVO_STATIC_HOST = "static.kivo.wiki"
MAX_METADATA_BYTES = 8 * 1024 * 1024
MAX_AUDIO_BYTES = 32 * 1024 * 1024
NETWORK_TIMEOUT_SECONDS = 30
FFMPEG_TIMEOUT_SECONDS = 180
MODERATE_TEXT_MIN = 12
MODERATE_TEXT_MAX = 50
IDEAL_TEXT_LENGTH = 28
PREFERRED_CATEGORIES = ("lobby", "event", "login")
USER_AGENT = "sunabot-kivo-reference/1.0 (+https://kivo.wiki/)"
LANGUAGE_METADATA_FIELDS = (
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
)


class KivoVoiceReferenceError(RuntimeError):
    """Raised when a reference voice cannot be selected or prepared safely."""


@dataclass(frozen=True)
class KivoCharacter:
    agent: str
    student_id: int
    display_name: str

    @property
    def api_url(self) -> str:
        return f"{API_BASE_URL}/{self.student_id}"

    @property
    def character_url(self) -> str:
        return f"https://kivo.wiki/data/character/{self.student_id}"


@dataclass(frozen=True)
class ReferenceVoice:
    text: str
    source_url: str
    category: str
    description: str
    source_index: int


@dataclass(frozen=True)
class AgentVoicePaths:
    workspace: Path
    agent_root: Path
    voice_root: Path
    references_root: Path
    profile_file: Path


CHARACTERS: dict[str, KivoCharacter] = {
    "koharu": KivoCharacter("koharu", 157, "下江小春"),
    "plana": KivoCharacter("plana", 173, "普拉娜"),
    "arona": KivoCharacter("arona", 104, "阿罗娜"),
}


_JAPANESE_KANA_RE = re.compile(r"[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]")
_WHITESPACE_RE = re.compile(r"\s+")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def japanese_text_length(text: str) -> int:
    """Return the visible length used to rank a Japanese reference sentence."""

    return len(_WHITESPACE_RE.sub("", text))


def contains_japanese(text: str) -> bool:
    """Require kana so Chinese-only metadata is not mistaken for Japanese."""

    return bool(_JAPANESE_KANA_RE.search(text))


def normalize_kivo_audio_url(raw_url: str) -> str:
    """Normalize a Kivo voice URL and reject unexpected schemes or hosts."""

    if not isinstance(raw_url, str) or not raw_url.strip():
        raise KivoVoiceReferenceError("Kivo voice entry has no audio URL")

    value = raw_url.strip()
    if value.startswith("//"):
        value = f"https:{value}"

    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise KivoVoiceReferenceError(f"Invalid Kivo audio URL: {raw_url!r}") from exc

    if parsed.scheme.lower() != "https":
        raise KivoVoiceReferenceError("Kivo audio URL must use HTTPS")
    if parsed.username or parsed.password:
        raise KivoVoiceReferenceError("Kivo audio URL must not contain credentials")
    if (parsed.hostname or "").lower() != KIVO_STATIC_HOST or port is not None:
        raise KivoVoiceReferenceError(
            f"Kivo audio URL must use {KIVO_STATIC_HOST} without a custom port"
        )
    if not parsed.path.startswith("/voices/"):
        raise KivoVoiceReferenceError("Kivo audio URL must point to /voices/")

    return urlunsplit(("https", KIVO_STATIC_HOST, parsed.path, parsed.query, ""))


def _category_priority(category: str) -> int:
    normalized = re.sub(r"[^a-z0-9]+", " ", category.lower()).strip()
    tokens = set(normalized.split())
    for index, preferred in enumerate(PREFERRED_CATEGORIES):
        if preferred in tokens or preferred in normalized:
            return index
    return len(PREFERRED_CATEGORIES)


def select_reference_voice(payload: Mapping[str, Any]) -> ReferenceVoice:
    """Select a deterministic Japanese voice, preferring moderate lobby/event/login lines."""

    data = payload.get("data")
    voices = data.get("voice") if isinstance(data, Mapping) else None
    if not isinstance(voices, list):
        raise KivoVoiceReferenceError("Kivo response does not contain data.voice")

    candidates: list[ReferenceVoice] = []
    for index, raw_voice in enumerate(voices):
        if not isinstance(raw_voice, Mapping):
            continue

        text = raw_voice.get("text_original")
        raw_url = raw_voice.get("file")
        if not isinstance(text, str) or not contains_japanese(text):
            continue
        try:
            source_url = normalize_kivo_audio_url(raw_url)
        except KivoVoiceReferenceError:
            continue

        category_value = raw_voice.get("category")
        description_value = raw_voice.get("description")
        category = category_value.strip() if isinstance(category_value, str) else ""
        description = (
            description_value.strip() if isinstance(description_value, str) else ""
        )
        candidates.append(
            ReferenceVoice(
                text=text.strip(),
                source_url=source_url,
                category=category,
                description=description,
                source_index=index,
            )
        )

    if not candidates:
        raise KivoVoiceReferenceError("Kivo returned no usable Japanese voice entries")

    moderate = [
        voice
        for voice in candidates
        if MODERATE_TEXT_MIN <= japanese_text_length(voice.text) <= MODERATE_TEXT_MAX
    ]
    pool = moderate or candidates
    return min(
        pool,
        key=lambda voice: (
            _category_priority(voice.category),
            abs(japanese_text_length(voice.text) - IDEAL_TEXT_LENGTH),
            japanese_text_length(voice.text),
            voice.source_index,
        ),
    )


def build_agent_paths(workspace: Path | str, agent: str) -> AgentVoicePaths:
    """Build the only paths this script is allowed to write for an agent."""

    if agent not in CHARACTERS:
        raise KivoVoiceReferenceError(f"Unsupported agent: {agent}")
    workspace_path = Path(workspace).expanduser().resolve(strict=False)
    agent_root = workspace_path / "business" / "agents" / agent
    voice_root = agent_root / "voice"
    references_root = voice_root / "references"
    return AgentVoicePaths(
        workspace=workspace_path,
        agent_root=agent_root,
        voice_root=voice_root,
        references_root=references_root,
        profile_file=voice_root / "profile.json",
    )


def content_addressed_reference_file(paths: AgentVoicePaths, sha256: str) -> Path:
    """Return the repository-approved content-addressed Japanese WAV path."""

    if not _SHA256_RE.fullmatch(sha256):
        raise KivoVoiceReferenceError("Reference sha256 must be 64 lowercase hex characters")
    return paths.references_root / f"kivo-ja-{sha256}.wav"


def _canonical_existing_language(value: Any, language: str) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise KivoVoiceReferenceError(
            f"voice/profile.json languages.{language} must be an object or null"
        )
    missing = [field for field in LANGUAGE_METADATA_FIELDS if field not in value]
    if missing:
        raise KivoVoiceReferenceError(
            f"voice/profile.json languages.{language} is missing: {', '.join(missing)}"
        )
    if value.get("language") != language:
        raise KivoVoiceReferenceError(
            f"voice/profile.json languages.{language}.language must be {language!r}"
        )
    return {field: copy.deepcopy(value[field]) for field in LANGUAGE_METADATA_FIELDS}


def merge_voice_profile(
    existing: Mapping[str, Any] | None,
    *,
    candidate: ReferenceVoice,
    character: KivoCharacter,
    sha256: str,
    size_bytes: int,
    updated_at: str,
) -> dict[str, Any]:
    """Build the repository's exact v1 profile while retaining valid zh/en metadata."""

    if existing is None:
        existing_profile: dict[str, Any] = {}
    elif isinstance(existing, Mapping):
        existing_profile = copy.deepcopy(dict(existing))
    else:
        raise KivoVoiceReferenceError("voice/profile.json must contain a JSON object")

    if not _SHA256_RE.fullmatch(sha256):
        raise KivoVoiceReferenceError("Reference sha256 must be 64 lowercase hex characters")
    if not isinstance(size_bytes, int) or isinstance(size_bytes, bool) or size_bytes <= 0:
        raise KivoVoiceReferenceError("Reference sizeBytes must be a positive integer")

    languages_value = existing_profile.get("languages")
    if languages_value is None:
        existing_languages: Mapping[str, Any] = {}
    elif isinstance(languages_value, Mapping):
        existing_languages = languages_value
    else:
        raise KivoVoiceReferenceError("voice/profile.json languages must be an object")

    ja_profile = {
        "language": "ja",
        "fileName": "kivo-ja.wav",
        "relativePath": f"voice/references/kivo-ja-{sha256}.wav",
        "mimeType": "audio/wav",
        "sizeBytes": size_bytes,
        "sha256": sha256,
        "referenceText": candidate.text,
        "sourceUrl": candidate.source_url,
        "characterUrl": character.character_url,
        "updatedAt": updated_at,
    }
    return {
        "schemaVersion": 1,
        "enabled": True,
        "defaultLanguage": "ja",
        "languages": {
            "zh": _canonical_existing_language(existing_languages.get("zh"), "zh"),
            "en": _canonical_existing_language(existing_languages.get("en"), "en"),
            "ja": ja_profile,
        },
    }


def _read_limited(response: Any, maximum_bytes: int, label: str) -> bytes:
    content_length = response.headers.get("Content-Length")
    if content_length:
        try:
            if int(content_length) > maximum_bytes:
                raise KivoVoiceReferenceError(f"{label} exceeds {maximum_bytes} bytes")
        except ValueError:
            pass

    content = response.read(maximum_bytes + 1)
    if len(content) > maximum_bytes:
        raise KivoVoiceReferenceError(f"{label} exceeds {maximum_bytes} bytes")
    return content


def fetch_kivo_metadata(character: KivoCharacter) -> dict[str, Any]:
    request = Request(
        character.api_url,
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
    )
    try:
        with urlopen(request, timeout=NETWORK_TIMEOUT_SECONDS) as response:
            final_url = urlsplit(response.geturl())
            if (
                final_url.scheme.lower() != "https"
                or (final_url.hostname or "").lower() != "api.kivo.wiki"
            ):
                raise KivoVoiceReferenceError("Kivo API redirected to an unexpected host")
            raw_payload = _read_limited(response, MAX_METADATA_BYTES, "Kivo metadata")
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise KivoVoiceReferenceError(f"Failed to request Kivo metadata: {exc}") from exc

    try:
        payload = json.loads(raw_payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise KivoVoiceReferenceError("Kivo metadata is not valid UTF-8 JSON") from exc
    if not isinstance(payload, dict):
        raise KivoVoiceReferenceError("Kivo metadata root must be a JSON object")

    data = payload.get("data")
    response_id = data.get("id") if isinstance(data, Mapping) else None
    try:
        normalized_id = int(response_id)
    except (TypeError, ValueError) as exc:
        raise KivoVoiceReferenceError("Kivo metadata does not contain a valid student id") from exc
    if normalized_id != character.student_id:
        raise KivoVoiceReferenceError(
            f"Kivo returned student {normalized_id}, expected {character.student_id}"
        )
    return payload


def _download_audio(source_url: str, destination: Path) -> None:
    approved_url = normalize_kivo_audio_url(source_url)
    request = Request(
        approved_url,
        headers={"Accept": "audio/*,application/ogg", "User-Agent": USER_AGENT},
    )
    try:
        with urlopen(request, timeout=NETWORK_TIMEOUT_SECONDS) as response:
            normalize_kivo_audio_url(response.geturl())
            content_type = response.headers.get_content_type().lower()
            allowed_type = content_type.startswith("audio/") or content_type in {
                "application/ogg",
                "application/octet-stream",
            }
            if not allowed_type:
                raise KivoVoiceReferenceError(
                    f"Kivo audio returned unsupported content type: {content_type}"
                )
            content = _read_limited(response, MAX_AUDIO_BYTES, "Kivo audio")
            if not content:
                raise KivoVoiceReferenceError("Kivo audio response is empty")
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise KivoVoiceReferenceError(f"Failed to download Kivo audio: {exc}") from exc

    with destination.open("xb") as output:
        output.write(content)


def _require_ffmpeg() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise KivoVoiceReferenceError(
            "ffmpeg is required to convert the Kivo reference to 48 kHz stereo WAV"
        )
    return ffmpeg


def _convert_to_wav(ffmpeg: str, source: Path, destination: Path) -> None:
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        str(source),
        "-vn",
        "-map_metadata",
        "-1",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        str(destination),
    ]
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise KivoVoiceReferenceError(f"ffmpeg conversion failed: {exc}") from exc
    if completed.returncode != 0:
        detail = completed.stderr.strip() or f"exit code {completed.returncode}"
        raise KivoVoiceReferenceError(f"ffmpeg conversion failed: {detail}")

    try:
        with wave.open(str(destination), "rb") as wav_file:
            valid = (
                wav_file.getframerate() == 48000
                and wav_file.getnchannels() == 2
                and wav_file.getsampwidth() == 2
                and wav_file.getnframes() > 0
            )
    except (OSError, EOFError, wave.Error) as exc:
        raise KivoVoiceReferenceError("ffmpeg did not produce a valid WAV file") from exc
    if not valid:
        raise KivoVoiceReferenceError(
            "ffmpeg output must be non-empty 48 kHz stereo 16-bit PCM WAV"
        )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_existing_profile(path: Path) -> dict[str, Any]:
    if path.is_symlink():
        raise KivoVoiceReferenceError(f"Refusing to overwrite symlink: {path}")
    if not path.exists():
        return {}
    if not path.is_file():
        raise KivoVoiceReferenceError(f"Voice profile is not a regular file: {path}")
    try:
        with path.open("r", encoding="utf-8") as source:
            value = json.load(source)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise KivoVoiceReferenceError(f"Failed to read existing voice profile: {exc}") from exc
    if not isinstance(value, dict):
        raise KivoVoiceReferenceError("voice/profile.json must contain a JSON object")
    return value


def _assert_safe_paths(paths: AgentVoicePaths) -> None:
    if not paths.workspace.exists() or not paths.workspace.is_dir():
        raise KivoVoiceReferenceError(f"Workspace directory does not exist: {paths.workspace}")

    workspace = paths.workspace.resolve()
    for path in (
        paths.agent_root,
        paths.voice_root,
        paths.references_root,
        paths.profile_file,
    ):
        try:
            path.resolve(strict=False).relative_to(workspace)
        except ValueError as exc:
            raise KivoVoiceReferenceError(f"Refusing path outside workspace: {path}") from exc

    for target in (paths.profile_file,):
        if target.is_symlink():
            raise KivoVoiceReferenceError(f"Refusing to overwrite symlink: {target}")
        if target.exists() and not target.is_file():
            raise KivoVoiceReferenceError(f"Target is not a regular file: {target}")


def _write_profile_atomically(path: Path, profile: Mapping[str, Any]) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".profile.", suffix=".json.tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            descriptor = -1
            json.dump(profile, output, ensure_ascii=False, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
    except Exception:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass
        raise


def _timestamp_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _result_document(
    *,
    character: KivoCharacter,
    candidate: ReferenceVoice,
    paths: AgentVoicePaths,
    dry_run: bool,
    reference_file: Path | None = None,
    sha256: str | None = None,
    size_bytes: int | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "dryRun": dry_run,
        "agent": character.agent,
        "studentId": character.student_id,
        "displayName": character.display_name,
        "language": "ja",
        "referenceText": candidate.text,
        "sourceUrl": candidate.source_url,
        "characterUrl": character.character_url,
        "category": candidate.category,
        "profileFile": str(paths.profile_file),
    }
    if reference_file is None:
        result["referenceFilePattern"] = str(
            paths.references_root / "kivo-ja-<sha256>.wav"
        )
    else:
        result["referenceFile"] = str(reference_file)
    if sha256 is not None:
        result["sha256"] = sha256
    if size_bytes is not None:
        result["sizeBytes"] = size_bytes
    return result


def prepare_reference(
    *, agent: str, workspace: Path | str, dry_run: bool
) -> dict[str, Any]:
    character = CHARACTERS.get(agent)
    if character is None:
        raise KivoVoiceReferenceError(f"Unsupported agent: {agent}")
    paths = build_agent_paths(workspace, agent)
    _assert_safe_paths(paths)

    payload = fetch_kivo_metadata(character)
    candidate = select_reference_voice(payload)
    if dry_run:
        return _result_document(
            character=character,
            candidate=candidate,
            paths=paths,
            dry_run=True,
        )

    ffmpeg = _require_ffmpeg()
    existing_profile = _load_existing_profile(paths.profile_file)
    paths.references_root.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=".kivo-voice-", dir=paths.voice_root) as temp_dir:
        temporary_root = Path(temp_dir)
        downloaded_audio = temporary_root / "source.ogg"
        converted_wav = temporary_root / "kivo-ja.wav"
        _download_audio(candidate.source_url, downloaded_audio)
        _convert_to_wav(ffmpeg, downloaded_audio, converted_wav)

        size_bytes = converted_wav.stat().st_size
        sha256 = _sha256_file(converted_wav)
        reference_file = content_addressed_reference_file(paths, sha256)
        if reference_file.is_symlink():
            raise KivoVoiceReferenceError(f"Refusing to overwrite symlink: {reference_file}")
        if reference_file.exists() and not reference_file.is_file():
            raise KivoVoiceReferenceError(f"Target is not a regular file: {reference_file}")
        profile = merge_voice_profile(
            existing_profile,
            candidate=candidate,
            character=character,
            sha256=sha256,
            size_bytes=size_bytes,
            updated_at=_timestamp_now(),
        )
        os.replace(converted_wav, reference_file)
        _write_profile_atomically(paths.profile_file, profile)

    return _result_document(
        character=character,
        candidate=candidate,
        paths=paths,
        dry_run=False,
        reference_file=reference_file,
        sha256=sha256,
        size_bytes=size_bytes,
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Select a Japanese Kivo voice, convert it to 48 kHz stereo WAV, "
            "and merge the Sunabot agent voice profile."
        )
    )
    parser.add_argument("--agent", required=True, choices=tuple(CHARACTERS))
    parser.add_argument(
        "--workspace",
        default="workspace",
        help="Sunabot workspace root (default: workspace)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Select and print the reference without downloading audio or writing files",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        result = prepare_reference(
            agent=args.agent,
            workspace=args.workspace,
            dry_run=args.dry_run,
        )
    except (KivoVoiceReferenceError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
