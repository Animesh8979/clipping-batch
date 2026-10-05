$installDir = "$PSScriptRoot\gcloud-sdk"
if (-Not (Test-Path "$installDir\google-cloud-sdk\bin\gcloud.cmd")) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $zipPath = "$installDir\gcloud.zip"
    Write-Host "Downloading Google Cloud SDK (this will take a minute)..."
    (New-Object Net.WebClient).DownloadFile("https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-windows-x86_64.zip", $zipPath)
    Write-Host "Extracting SDK..."
    Expand-Archive -Path $zipPath -DestinationPath $installDir -Force
    Remove-Item $zipPath
}

$binPath = "$installDir\google-cloud-sdk\bin"
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -notmatch [regex]::Escape($binPath)) {
    Write-Host "Adding gcloud to your User PATH..."
    [Environment]::SetEnvironmentVariable("PATH", "$userPath;$binPath", "User")
}

Write-Host "SDK Ready. Launching authentication window..."
$gcloudCmd = "$binPath\gcloud.cmd"
Start-Process cmd.exe -ArgumentList "/k `"title Google Cloud Authentication && echo Log in using the browser window that pops up... && `"$gcloudCmd`" auth application-default login`""

