# check-complete.ps1 — Native Windows PowerShell phase completion checker for planning-with-files
param(
    [string]$PlanFile = "task_plan.md"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $PlanFile)) {
    Write-Host "ERROR: $PlanFile not found" -ForegroundColor Red
    Write-Host "Cannot verify completion without a task plan."
    exit 1
}

Write-Host "=== Task Completion Check ==="
Write-Host ""

$content = Get-Content -Path $PlanFile -Raw -Encoding UTF8

# Count phases by status
$total = ([regex]::Matches($content, "(?m)^###\s+Phase")).Count
$complete = ([regex]::Matches($content, "(?m)\*\*Status:\*\*\s+complete")).Count
$inProgress = ([regex]::Matches($content, "(?m)\*\*Status:\*\*\s+in_progress")).Count
$pending = ([regex]::Matches($content, "(?m)\*\*Status:\*\*\s+pending")).Count

Write-Host "Total phases:   $total"
Write-Host "Complete:       $complete"
Write-Host "In progress:    $inProgress"
Write-Host "Pending:        $pending"
Write-Host ""

if ($total -gt 0 -and $complete -eq $total) {
    Write-Host "ALL PHASES COMPLETE" -ForegroundColor Green
    exit 0
} else {
    Write-Host "TASK NOT COMPLETE" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Do not stop until all phases are complete."
    exit 1
}
