@echo off
rem Starts the OctoClient cosmetics API on port 8765.
rem For public hosting add a token, e.g.:
rem   set OCTOCLIENT_API_TOKEN=geheim
cd /d "%~dp0"
python octoclient_api.py --port 8765
pause
