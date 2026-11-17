param(
  [string]$Python = 'python',
  [string]$ModelCache
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $repoRoot 'data/vieneu'
$venv = Join-Path $runtime '.venv'
$interpreter = Join-Path $venv 'Scripts/python.exe'
$model = Join-Path $runtime 'model'

if (-not (Test-Path -LiteralPath $interpreter)) {
  & $Python -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the VieNeu-TTS Python environment.' }
}
& $interpreter -m pip install --disable-pip-version-check -r (Join-Path $PSScriptRoot 'requirements-vieneu.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install VieNeu-TTS.' }

@'
import shutil
import sys
from pathlib import Path
from huggingface_hub import snapshot_download

files = ["config.json", "constants.npz", "text_encoder.onnx", "duration_predictor.onnx", "vector_estimator.onnx", "codec_decoder.onnx"]
model_dir = Path(sys.argv[1])
cache = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else None
snapshot = Path(snapshot_download(
    repo_id="pnnbao-ump/VieNeu-TTS-v3-Nano",
    revision="aba295eb96a6fa6003ebe417cc1f2802a7adc1dc",
    allow_patterns=files,
    cache_dir=cache,
))
model_dir.mkdir(parents=True, exist_ok=True)
for name in files:
    src, dest = snapshot / name, model_dir / name
    if not dest.is_file() or src.stat().st_size != dest.stat().st_size:
        staged = dest.with_suffix(dest.suffix + ".partial")
        shutil.copyfile(src, staged)
        staged.replace(dest)
'@ | & $interpreter -X utf8 - $model $ModelCache
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the pinned VieNeu-TTS model files.' }

Write-Output "VieNeu-TTS Python: $interpreter"
Write-Output "VieNeu-TTS model: $model"
