@echo off
REM ─────────────────────────────────────────────────────────────
REM Veo Flow re-auth — run ONCE, sign in, close browser, done.
REM After this, Veo image-to-video gens work for ~30 days.
REM ─────────────────────────────────────────────────────────────
cd /d "D:\anitgravity work"
echo.
echo === Veo Flow re-auth ===
echo A Chrome window will open at labs.google/flow
echo 1. Sign in with your Google account (the one with AI Pro)
echo 2. Wait until you see the Flow editor (~10 sec)
echo 3. Close the Chrome window
echo The persistent session is saved to .runtime-cache\playwright-google\
echo.
pause

set GOOGLE_FLOW_SESSION=1
set FLOW_HEADFUL=1
set FLOW_TIMEOUT_MS=900000

node lib/providers/google-veo-browser.js --prompt "cinematic wide shot of stadium at golden hour, slow plunge from sky to pitch, anamorphic flare, 9:16 vertical, no text"

echo.
echo If you saw a "veo_budget_exhausted" or "flow_result_timeout" message but
echo logged in successfully, the session IS saved — re-runs will work.
echo.
pause
