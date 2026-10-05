"""voice_engine.py — Zero-bloat local voice & speech synthesis engine for Antigravity.

Designed specifically for Windows workstations:
- Tier 1: Native Windows SAPI via System.Speech.Synthesis (0MB RAM, zero external dependencies, 100% offline).
- Audio Memoization: SQLite cache for repetitive agent notifications.
- Zero VRAM: Guaranteed to never touch NVIDIA GPU memory, preserving all 4GB VRAM for LLM reasoning.
"""

import hashlib
import os
from pathlib import Path
import sqlite3
import subprocess
from typing import Optional, Tuple

CACHE_DIR = Path(r"D:\skills-library\local-voice\.cache")
DB_PATH = CACHE_DIR / "speech_cache.db"


class LocalVoiceEngine:
    def __init__(self, cache_dir: Optional[Path] = None):
        self.cache_dir = cache_dir or CACHE_DIR
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.cache_dir / "speech_cache.db"
        self._init_db()

    def _init_db(self) -> None:
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS speech_cache (
                    hash_key TEXT PRIMARY KEY,
                    text_content TEXT,
                    audio_path TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.commit()

    def _get_hash(self, text: str, voice_name: str, rate: int) -> str:
        raw = f"{text.strip().lower()}:{voice_name}:{rate}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def synthesize_sapi_wav(
        self,
        text: str,
        output_wav: Optional[Path] = None,
        rate: int = 0,
        volume: int = 100,
    ) -> Path:
        """Synthesize text to WAV file using native Windows SAPI.

        Rate ranges from -10 to +10. Volume ranges from 0 to 100.
        Uses SQLite cache to avoid re-synthesizing repeated phrases.
        """
        clean_text = text.strip().replace('"', '""')
        hash_key = self._get_hash(clean_text, "default", rate)

        with sqlite3.connect(self.db_path) as conn:
            cur = conn.execute(
                "SELECT audio_path FROM speech_cache WHERE hash_key = ?",
                (hash_key,),
            )
            row = cur.fetchone()
            if row and Path(row[0]).exists():
                return Path(row[0])

        if not output_wav:
            output_wav = self.cache_dir / f"{hash_key[:16]}.wav"

        ps_script = f"""
        Add-Type -AssemblyName System.Speech
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $synth.Rate = {rate}
        $synth.Volume = {volume}
        $synth.SetOutputToWaveFile('{str(output_wav)}')
        $synth.Speak("{clean_text}")
        $synth.Dispose()
        """

        cmd = ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script]
        res = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )

        if res.returncode != 0 or not output_wav.exists():
            raise RuntimeError(f"SAPI synthesis failed: {res.stderr}")

        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO speech_cache (hash_key, text_content, audio_path) VALUES (?, ?, ?)",
                (hash_key, text, str(output_wav)),
            )
            conn.commit()

        return output_wav

    def speak(self, text: str, rate: int = 0, async_play: bool = False) -> None:
        """Speak text aloud through default Windows audio device."""
        clean_text = text.strip().replace('"', '""')
        ps_script = f"""
        Add-Type -AssemblyName System.Speech
        $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
        $synth.Rate = {rate}
        $synth.Speak("{clean_text}")
        $synth.Dispose()
        """
        cmd = ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps_script]
        if async_play:
            subprocess.Popen(cmd)
        else:
            subprocess.run(cmd, check=True)
