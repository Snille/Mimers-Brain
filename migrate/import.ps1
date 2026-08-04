# Imports thoughts.tsv into Mimers Valv. Each line is "<tier>\t<content>".
# Idempotent: upsert_thought dedupes on a content fingerprint, so re-running
# merges metadata instead of creating duplicates.
param(
    [string]$HostName = "192.0.2.41",
    [string]$TsvFile = "thoughts.tsv",
    [Parameter(Mandatory)][string]$KeyFile
)
$ErrorActionPreference = "Stop"

# Content-Type must NOT go in here. Invoke-RestMethod only encodes the body as
# UTF-8 when it sees a charset on the -ContentType *parameter*; set via -Headers
# it silently falls back to ISO-8859-1, and every a-ring and umlaut arrives at
# the server as invalid UTF-8 and is stored as U+FFFD. Sending bytes is belt and
# braces on top of that.
$H = @{ Authorization = "Bearer $((Get-Content $KeyFile -Raw).Trim())" }
$B = "http://${HostName}:8790"
$file = if ([System.IO.Path]::IsPathRooted($TsvFile)) { $TsvFile } else { Join-Path $PSScriptRoot $TsvFile }

$ok = 0; $bad = 0
foreach ($line in Get-Content $file -Encoding utf8) {
    if (-not $line.Trim()) { continue }
    $tier, $content = $line -split "`t", 2
    if (-not $content) { Write-Host "  hoppar over rad utan innehall" -ForegroundColor Yellow; continue }
    try {
        $json = @{ content = $content; tier = $tier } | ConvertTo-Json -Compress
        $r = Invoke-RestMethod "$B/api/thoughts" -Method Post -Headers $H `
            -ContentType "application/json; charset=utf-8" `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
        $ok++
        $emb = if ($r.embedded) { "" } else { "  (UTAN EMBEDDING)" }
        Write-Host ("  [{0,-5}] {1}{2}" -f $r.tier, $content.Substring(0, [Math]::Min(64, $content.Length)), $emb) -ForegroundColor Green
    } catch {
        $bad++
        Write-Host "  MISSLYCKADES: $($_.Exception.Message)" -ForegroundColor Red
    }
}
Write-Host "`n$ok importerade, $bad misslyckade" -ForegroundColor $(if ($bad) { "Red" } else { "Green" })
