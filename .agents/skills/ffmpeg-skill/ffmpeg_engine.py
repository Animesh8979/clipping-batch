"""ffmpeg_engine.py — Production-grade, zero-dependency FFmpeg orchestration for Antigravity.

Targets verified local binaries at D:\\tools\\ffmpeg\\bin\\ffmpeg.exe and ffprobe.exe.
Enforces GTX 1650 VRAM safety:
- Prefers CPU libx264 -preset veryfast for short clips to preserve 100% GPU VRAM for LLM reasoning.
- Supports guarded h264_nvenc with Volta NVENC presets (-preset p4 -cq 23) when hardware encoding is explicitly requested.
- Automatic lossless stream copying (-c copy) when no transcoding is needed.
"""

from dataclasses import dataclass
import json
import os
from pathlib import Path
import subprocess
from typing import List, Optional, Tuple

FFMPEG_PATH = Path(r"D:\tools\ffmpeg\bin\ffmpeg.exe")
FFPROBE_PATH = Path(r"D:\tools\ffmpeg\bin\ffprobe.exe")


@dataclass
class MediaProbeInfo:
    duration: float
    width: int
    height: int
    video_codec: str
    audio_codec: Optional[str]
    bitrate: int
    fps: float


class FFmpegEngine:
    def __init__(
        self,
        ffmpeg_bin: Optional[Path] = None,
        ffprobe_bin: Optional[Path] = None,
    ):
        self.ffmpeg_bin = ffmpeg_bin or FFMPEG_PATH
        self.ffprobe_bin = ffprobe_bin or FFPROBE_PATH
        self._validate_binaries()

    def _validate_binaries(self) -> None:
        if not self.ffmpeg_bin.exists():
            raise FileNotFoundError(
                f"FFmpeg binary not found at: {self.ffmpeg_bin}"
            )
        if not self.ffprobe_bin.exists():
            raise FileNotFoundError(
                f"FFprobe binary not found at: {self.ffprobe_bin}"
            )

    def probe(self, input_file: Path) -> MediaProbeInfo:
        """Inspect media file streams and metadata using ffprobe."""
        if not input_file.exists():
            raise FileNotFoundError(f"Input file not found: {input_file}")

        cmd = [
            str(self.ffprobe_bin),
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(input_file),
        ]
        res = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        if res.returncode != 0:
            raise RuntimeError(f"FFprobe error ({res.returncode}): {res.stderr}")

        data = json.loads(res.stdout)
        video_stream = next(
            (s for s in data.get("streams", []) if s.get("codec_type") == "video"),
            None,
        )
        audio_stream = next(
            (s for s in data.get("streams", []) if s.get("codec_type") == "audio"),
            None,
        )

        if not video_stream:
            raise ValueError(f"No video stream found in {input_file}")

        fmt = data.get("format", {})
        duration = float(fmt.get("duration", 0.0))
        bitrate = int(fmt.get("bit_rate", 0))

        # Parse FPS fraction (e.g., '30/1' or '24000/1001')
        fps_str = video_stream.get("r_frame_rate", "30/1")
        if "/" in fps_str:
            num, den = fps_str.split("/")
            fps = float(num) / float(den) if float(den) > 0 else 30.0
        else:
            fps = float(fps_str)

        return MediaProbeInfo(
            duration=duration,
            width=int(video_stream.get("width", 0)),
            height=int(video_stream.get("height", 0)),
            video_codec=video_stream.get("codec_name", "unknown"),
            audio_codec=audio_stream.get("codec_name") if audio_stream else None,
            bitrate=bitrate,
            fps=fps,
        )

    def cut_clip(
        self,
        input_file: Path,
        output_file: Path,
        start_seconds: float,
        end_seconds: float,
        lossless: bool = True,
    ) -> List[str]:
        """Cut a segment.

        If lossless=True, uses -c copy with fast seek.
        """
        duration = end_seconds - start_seconds
        if duration <= 0:
            raise ValueError("end_seconds must be greater than start_seconds")

        cmd = [str(self.ffmpeg_bin), "-y", "-ss", f"{start_seconds:.3f}"]
        cmd.extend(["-i", str(input_file)])
        cmd.extend(["-t", f"{duration:.3f}"])

        if lossless:
            cmd.extend(["-c", "copy", "-avoid_negative_ts", "make_zero"])
        else:
            # CPU libx264 safe transcode
            cmd.extend(
                [
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "22",
                    "-c:a",
                    "aac",
                    "-b:a",
                    "128k",
                ]
            )

        cmd.append(str(output_file))
        return cmd

    def transcode_gtx1650(
        self,
        input_file: Path,
        output_file: Path,
        use_nvenc: bool = False,
        crf_cq: int = 23,
    ) -> List[str]:
        """Generate transcode command for GTX 1650.

        If use_nvenc=True, uses Volta NVENC p4 preset (avoiding unsupported Turing B-frame flags).
        If use_nvenc=False, uses CPU libx264 to keep 100% of 4GB VRAM free for local LLMs/AST tasks.
        """
        cmd = [str(self.ffmpeg_bin), "-y", "-i", str(input_file)]

        if use_nvenc:
            cmd.extend(
                [
                    "-c:v",
                    "h264_nvenc",
                    "-preset",
                    "p4",  # P4 is safe on Volta TU117
                    "-cq",
                    str(crf_cq),
                    "-c:a",
                    "aac",
                    "-b:a",
                    "160k",
                ]
            )
        else:
            cmd.extend(
                [
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    str(crf_cq),
                    "-c:a",
                    "aac",
                    "-b:a",
                    "160k",
                ]
            )

        cmd.append(str(output_file))
        return cmd

    def normalize_audio_command(
        self,
        input_file: Path,
        output_file: Path,
        target_lufs: float = -14.0,
    ) -> List[str]:
        """Generate EBU R128 loudness normalization command (broadcast standard -14 LUFS)."""
        return [
            str(self.ffmpeg_bin),
            "-y",
            "-i",
            str(input_file),
            "-c:v",
            "copy",
            "-filter:a",
            f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11",
            str(output_file),
        ]

    def execute(self, cmd: List[str]) -> Tuple[int, str]:
        """Execute the generated FFmpeg command and capture stdout/stderr."""
        res = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        return res.returncode, res.stderr
