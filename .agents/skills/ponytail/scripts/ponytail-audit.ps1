# ponytail-audit.ps1 — Audits code for over-engineering, boilerplate, and slop using the Ponytail Decision Ladder
param(
    [string]$Path = ".",
    [ValidateSet("lite", "full", "ultra")]
    [string]$Intensity = "full"
)

Write-Host "========================================================"
Write-Host "  PONYTAIL PROTOCOL AUDIT (Intensity: $Intensity)"
Write-Host "  Philosophy: The best code is the code never written."
Write-Host "========================================================"

if (-not (Test-Path $Path)) {
    Write-Host "Target path does not exist: $Path" -ForegroundColor Red
    exit 1
}

$files = Get-ChildItem -Path $Path -Recurse -Include *.py,*.ts,*.tsx,*.js -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch "node_modules|\.git|dist|build|venv" }
$totalLoc = 0
$findings = @()

foreach ($f in $files) {
    $lines = Get-Content $f.FullName -ErrorAction SilentlyContinue
    if (-not $lines) { continue }
    $totalLoc += $lines.Count

    if ($f.Extension -eq ".py") {
        $content = $lines -join "`n"
        if ($content -match "class.*Cache.*:" -and $content -notmatch "lru_cache") {
            $findings += "[Rung 3 - Stdlib] $($f.Name): Custom cache class detected. Consider functools.lru_cache."
        }
        if ($content -match "import requests" -and $content -notmatch "session") {
            $findings += "[Rung 3 - Stdlib] $($f.Name): Basic requests import. Python stdlib urllib.request avoids external dependency."
        }
    }

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line -match "class.*Factory.*:" -or $line -match "interface.*Factory.*") {
            $findings += "[Rung 1 - YAGNI] $($f.Name):line $($i+1): Factory pattern detected. Is there more than 1 concrete implementation?"
        }
        if ($line -match "// TODO: implement" -or $line -match "# TODO: implement") {
            $findings += "[Rung 1 - YAGNI] $($f.Name):line $($i+1): Unimplemented speculative stub detected."
        }
        if ($line -match "console\.log\(" -and $f.Extension -match "ts|tsx|js") {
            $findings += "[De-Sloppify] $($f.Name):line $($i+1): Lingering console.log statement."
        }
    }
}

Write-Host "`nScanned $($files.Count) files ($totalLoc total lines of code)."

if ($findings.Count -eq 0) {
    Write-Host "`n[PASS] Zero Ponytail violations detected. Codebase is lean and senior-grade." -ForegroundColor Green
    exit 0
} else {
    Write-Host "`nFound $($findings.Count) Ponytail optimization opportunities:" -ForegroundColor Yellow
    $findings | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
    exit 0
}
