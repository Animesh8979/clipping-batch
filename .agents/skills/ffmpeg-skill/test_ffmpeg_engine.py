"""test_ffmpeg_engine.py — Rigorous verification suite for FFmpegEngine."""

import os
from pathlib import Path
import unittest

from ffmpeg_engine import FFmpegEngine, FFMPEG_PATH, FFPROBE_PATH


class TestFFmpegEngine(unittest.TestCase):

    def setUp(self):
        self.engine = FFmpegEngine(FFMPEG_PATH, FFPROBE_PATH)
        self.sample_in = Path("sample_test_input.mp4")
        self.sample_out = Path("sample_test_output.mp4")

    def test_binaries_exist(self):
        """Verify local binaries exist on disk."""
        self.assertTrue(FFMPEG_PATH.exists(), f"Missing ffmpeg at {FFMPEG_PATH}")
        self.assertTrue(FFPROBE_PATH.exists(), f"Missing ffprobe at {FFPROBE_PATH}")

    def test_cut_clip_lossless_command(self):
        """Verify lossless cut command flags."""
        cmd = self.engine.cut_clip(
            self.sample_in, self.sample_out, 5.0, 15.0, lossless=True
        )
        self.assertIn("-ss", cmd)
        self.assertIn("5.000", cmd)
        self.assertIn("-t", cmd)
        self.assertIn("10.000", cmd)
        self.assertIn("-c", cmd)
        self.assertIn("copy", cmd)
        self.assertIn("-avoid_negative_ts", cmd)

    def test_cut_clip_invalid_bounds(self):
        """Verify negative or zero duration raises ValueError."""
        with self.assertRaises(ValueError):
            self.engine.cut_clip(
                self.sample_in, self.sample_out, 15.0, 10.0, lossless=True
            )

    def test_gtx1650_cpu_default_preserves_vram(self):
        """Verify default transcode uses CPU libx264 to preserve 100% VRAM."""
        cmd = self.engine.transcode_gtx1650(
            self.sample_in, self.sample_out, use_nvenc=False, crf_cq=22
        )
        self.assertIn("libx264", cmd)
        self.assertIn("veryfast", cmd)
        self.assertNotIn("h264_nvenc", cmd)

    def test_gtx1650_nvenc_flags(self):
        """Verify Volta TU117 safe preset is used when NVENC is enabled."""
        cmd = self.engine.transcode_gtx1650(
            self.sample_in, self.sample_out, use_nvenc=True, crf_cq=20
        )
        self.assertIn("h264_nvenc", cmd)
        self.assertIn("p4", cmd)
        self.assertIn("20", cmd)

    def test_loudnorm_command(self):
        """Verify EBU R128 loudness normalization filter string."""
        cmd = self.engine.normalize_audio_command(
            self.sample_in, self.sample_out, target_lufs=-14.0
        )
        self.assertIn("loudnorm=I=-14.0:TP=-1.5:LRA=11", cmd)


if __name__ == "__main__":
    unittest.main()
