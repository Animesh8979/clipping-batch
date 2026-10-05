# tools/fifa-day-chain.ps1 — L120: the sequenced FIFA day.
# PHASE 1: 2 FIFA organics (solo workload — nothing else competing for RAM/CPU)
# PHASE 2: 2 football clips (starts ONLY after organics fully done)
# Uploads: QUEUE_STAGGER_MIN=240 → 4h cadence, organics first, enforced at enqueue.
# Runs detached + hidden; the upload daemon outlives this script. Logs to renders\fifa-chain-<date>.log
$ErrorActionPreference = 'Continue'
$ROOT = 'D:\anitgravity work'
Set-Location $ROOT
$day = Get-Date -Format 'yyyy-MM-dd'
$LOG = "$ROOT\renders\fifa-chain-$day.log"
function Log($m) { Add-Content -LiteralPath $LOG -Value ("[{0}] [chain] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }

$env:UPLOAD_VIA_QUEUE = '1'
$env:QUEUE_STAGGER_MIN = '240'
$env:CLIP_FOOTBALL = '1'
$env:ORGANIC_STORY = '1'
$env:L110_WHISPER_LOCAL = '1'
$env:GOOGLE_FLOW_SESSION = '1'
$env:GOOGLE_FLOW_CDP = 'http://127.0.0.1:9222'
$env:RENDER_QA_MIN = '60'

Log "=== FIFA DAY CHAIN start (organics -> clips, 4h upload cadence) ==="

# Veo needs the Edge debug browser
try { Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 4 | Out-Null; Log 'Edge CDP up' }
catch {
  Log 'launching Edge for Veo'
  Start-Process msedge -ArgumentList '--remote-debugging-port=9222', '--user-data-dir=D:\anitgravity work\.runtime-cache\edge-flow', 'https://labs.google/fx/tools/flow'
  Start-Sleep 12
}

Log 'PHASE 1: organics x2 (FIFA) - solo workload'
& node tools\run-batch-resilient.js --organic 2 --clips 0 --fifa --max-retries 3 *>> $LOG
Log "phase1 exit=$LASTEXITCODE"

# preserve any new Veo clips to the permanent library (nothing goes to waste)
Get-ChildItem "$ROOT\.runtime-cache\veo\*.mp4" -ErrorAction SilentlyContinue | Where-Object { $_.Length -gt 100KB } | ForEach-Object {
  $dest = "$ROOT\assets\veo-library\$($_.Name)"
  if (-not (Test-Path $dest)) { Copy-Item $_.FullName $dest; Log "veo-library += $($_.Name)" }
}

Log 'PHASE 2: clips x2 (IShowSpeed/MrBeast football, 1080p-capped sources)'
& node tools\run-batch-resilient.js --organic 0 --clips 2 --max-retries 3 *>> $LOG
Log "phase2 exit=$LASTEXITCODE"

# belt-and-braces: final cadence pass + ensure daemon (singleton-guarded)
& node tools\restagger-queue.js 240 *>> $LOG
Log '=== CHAIN COMPLETE - daemon delivers on the 4h schedule ==='
