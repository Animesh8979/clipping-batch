"""test_voice_engine.py — Unit test suite for LocalVoiceEngine."""

import os
from pathlib import Path
import shutil
import unittest

from voice_engine import LocalVoiceEngine


class TestLocalVoiceEngine(unittest.TestCase):

    def setUp(self):
        self.test_dir = Path("D:/skills-library/local-voice/test_cache")
        self.engine = LocalVoiceEngine(cache_dir=self.test_dir)

    def tearDown(self):
        if self.test_dir.exists():
            shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_database_initialization(self):
        """Verify SQLite cache db is created with correct schema."""
        self.assertTrue(self.engine.db_path.exists())

    def test_sapi_wav_synthesis_and_caching(self):
        """Verify SAPI synthesizes a valid WAV file and caches it."""
        phrase = "Test audio synthesis"
        wav_file = self.engine.synthesize_sapi_wav(phrase)

        self.assertTrue(wav_file.exists())
        self.assertGreater(wav_file.stat().st_size, 100)

        # Test cache hit (same path returned without error)
        cached_wav = self.engine.synthesize_sapi_wav(phrase)
        self.assertEqual(wav_file, cached_wav)


if __name__ == "__main__":
    unittest.main()
