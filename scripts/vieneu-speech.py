"""Synthesize Vietnamese speech with the local Nano ONNX model over JSON-lines stdio."""

import base64
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

VOICES = {"Minh Quân", "Mỹ Duyên"}
MAX_CUE_CHARS = 72
MODEL_FILES = (
    "config.json", "constants.npz", "text_encoder.onnx", "duration_predictor.onnx", "vector_estimator.onnx",
    "codec_decoder.onnx",
)
engine = None


def split_cues(text):
    for sentence in re.split(r'''(?<=[.!?…])\s+|\n+''', text.strip()):
        parts = re.split(r"(?<=[,;:])\s+", sentence.strip())
        cue = ""
        for part in parts:
            part = " ".join(part.split())
            if not part:
                continue
            if len(part) <= MAX_CUE_CHARS and len(cue) + len(part) + 1 <= MAX_CUE_CHARS:
                cue = f"{cue} {part}".strip()
                continue
            if cue:
                yield cue
                cue = ""
            for word in part.split():
                if cue and len(cue) + len(word) + 1 > MAX_CUE_CHARS:
                    yield cue
                    cue = ""
                cue = f"{cue} {word}".strip()
        if cue:
            yield cue


def get_engine():
    global engine
    if engine is None:
        model = Path(os.environ["VIE_NEU_MODEL_DIR"])
        if any(not (model / name).is_file() for name in MODEL_FILES):
            raise FileNotFoundError("model")
        from vieneu import Vieneu

        engine = Vieneu(mode="v3nano", onnx_dir=str(model), threads=4)
    return engine


def encode_audio(samples, sample_rate):
    with tempfile.TemporaryDirectory(prefix="claw-vieneu-") as tmp:
        mp3 = Path(tmp) / "speech.mp3"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(sample_rate), "-ac", "1", "-i", "pipe:0",
             "-codec:a", "libmp3lame", "-b:a", "128k", str(mp3)],
            input=samples.astype("<f4", copy=False).tobytes(), capture_output=True, check=True, timeout=45,
        )
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
             "stream=codec_name:format=duration", "-of", "json", str(mp3)],
            capture_output=True, check=True, timeout=15,
        )
        info = json.loads(probe.stdout)
        if not info.get("streams") or info["streams"][0].get("codec_name") != "mp3":
            raise ValueError("Unexpected audio format")
        return mp3.read_bytes(), float(info["format"]["duration"])


def synthesize(text, voice, speed):
    import numpy as np

    model = get_engine()
    sample_rate = model.sample_rate
    padding = int(sample_rate * 0.05)
    chunks, cues = [], []
    cursor = 0
    for cue in split_cues(text):
        pcm = np.asarray(model.infer(cue, voice=voice, speed=speed), dtype=np.float32)
        audible = np.flatnonzero(np.abs(pcm) > 0.006)
        if not audible.size or not np.isfinite(pcm).all():
            return {"success": False, "error": "no_audio"}
        pcm = pcm[max(0, audible[0] - padding):audible[-1] + padding + 1]
        end = cursor + pcm.size
        cues.append({"text": cue, "startSeconds": cursor / sample_rate, "endSeconds": end / sample_rate})
        pause = 0.20 if cue.endswith((".", "?", "!", "…")) else 0.10 if cue.endswith((",", ";", ":")) else 0.05
        gap = round(sample_rate * pause)
        chunks.extend((pcm, np.zeros(gap, dtype=np.float32)))
        cursor = end + gap

    if not chunks:
        return {"success": False, "error": "no_audio"}
    audio, duration = encode_audio(np.concatenate(chunks), sample_rate)
    if not math.isfinite(duration) or duration < cues[-1]["endSeconds"]:
        return {"success": False, "error": "output_error"}
    return {"success": True, "mp3_base64": base64.b64encode(audio).decode("ascii"),
            "durationSeconds": duration, "voice": voice, "cues": cues}


def main():
    sys.stderr.write("VieNeu TTS worker started\n")
    sys.stderr.flush()
    for line in sys.stdin:
        job_id = None
        try:
            request = json.loads(line)
            job_id = request["id"]
            text, voice, speed = request["text"], request["voice"], request["speed"]
            if not isinstance(text, str) or not text.strip() or len(text) > 40000 or voice not in VOICES or not 0.7 <= speed <= 1.2:
                result = {"success": False, "error": "invalid_input"}
            else:
                with redirect_stdout(sys.stderr):
                    result = synthesize(text, voice, speed)
        except FileNotFoundError as error:
            result = {"success": False, "error": "model_not_found" if error.args == ("model",) else "unavailable"}
        except (ImportError, KeyError, OSError):
            result = {"success": False, "error": "unavailable"}
        except (subprocess.SubprocessError, ValueError):
            result = {"success": False, "error": "output_error"}
        except Exception:
            result = {"success": False, "error": "provider_error"}
        print(json.dumps({"id": job_id, **result}), flush=True)


if __name__ == "__main__":
    main()
