@echo off
chcp 65001 > nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [오류] 가상환경(.venv)이 없습니다. 먼저 python -m venv .venv 및 pip install -r requirements.txt 를 실행해 주세요.
  pause
  exit /b 1
)
echo MidiMoter 3단계 AI 변환 서버를 시작합니다 (http://127.0.0.1:8765)...
".venv\Scripts\python.exe" server.py
pause
