"""Install local-only audio validation dependencies and a pinned English model."""
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / 'scripts/.cache/audio-check/base.en'
REVISION = '3d3d5dee26484f91867d81cb899cfcf72b96be6c'
FILES = {
    'model.bin': '2a166925539a16005f14ff328359f9b9adb9dc4fb631bb3b227526862e93e2ef',
    'config.json': 'f3bc3821e9fc76a27bae538e11ae5b677dcdd352b4600429ce7951d398569aeb',
    'tokenizer.json': '929c5252409436dce1b38a75d1abbcb5e132d170d8e324e4e04ed915fa2d22df',
    'vocabulary.txt': 'ff77588746d3a2595d32ab5b69ffd7b95ce2441ac57533cb66fc3eb575a115cf',
}
if not shutil.which('ffmpeg'):
    raise SystemExit('请先安装 FFmpeg，再重新运行本命令。')
python = ROOT / '.venv/bin/python'
if not python.exists():
    venv.create(ROOT / '.venv', with_pip=True)
subprocess.run([str(python), '-m', 'ensurepip', '--upgrade'], check=True)
subprocess.run([str(python), '-m', 'pip', 'install', '-r', str(ROOT / 'scripts/audio/requirements.txt')], check=True)
MODEL.mkdir(parents=True, exist_ok=True)
for name, expected in FILES.items():
    target = MODEL / name
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
        continue
    partial = target.with_suffix(target.suffix + '.download')
    url = f'https://huggingface.co/Systran/faster-whisper-base.en/resolve/{REVISION}/{name}?download=true'
    subprocess.run(['curl', '-fL', '--retry', '2', '--connect-timeout', '20', '--max-time', '600', '-o', str(partial), url], check=True)
    if hashlib.sha256(partial.read_bytes()).hexdigest() != expected:
        partial.unlink(missing_ok=True)
        raise SystemExit('模型文件校验失败，请重试。')
    partial.replace(target)
print('音文校验已安装，音频识别会在本机离线完成。')
