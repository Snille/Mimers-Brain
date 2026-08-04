# Verifies the tier boundary: the open listener must not expose vault rows,
# must not accept vault writes, and must not serve a vault row by direct id.
#
#   .\test-isolation.ps1                                  # against localhost/.env
#   .\test-isolation.ps1 -Host 192.0.2.41 -KeyFile key.txt  # against the LXC
param(
    [string]$HostName = "localhost",
    [string]$KeyFile
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$key = if ($KeyFile) { (Get-Content $KeyFile -Raw).Trim() }
       else { ((Get-Content .env | Select-String '^MCP_ACCESS_KEY=(.*)$').Matches.Groups[1].Value).Trim() }
$H = @{ Authorization = "Bearer $key"; "Content-Type" = "application/json" }
$FULL = "http://${HostName}:8790"
$OPEN = "http://${HostName}:8791"
Write-Host "Testar mot $HostName" -ForegroundColor Cyan

$pass = 0; $fail = 0
function Check($name, $ok, $detail) {
    if ($ok) { $script:pass++; Write-Host "  PASS  $name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $name -- $detail" -ForegroundColor Red }
}

Write-Host "`nSkriver testdata via FULL-porten" -ForegroundColor Cyan
$o = Invoke-RestMethod "$FULL/api/thoughts" -Method Post -Headers $H -Body (@{
    content = "Oppen testanteckning: Proxmox nas pa 192.0.2.12 port 8006."
    tier = "open" } | ConvertTo-Json)
$v = Invoke-RestMethod "$FULL/api/thoughts" -Method Post -Headers $H -Body (@{
    content = "VALV testanteckning: hemligt losenord for testsystemet ar SUPERHEMLIGT-42."
    tier = "vault" } | ConvertTo-Json)
Check "vault-post fick tier=vault" ($v.tier -eq "vault") "fick '$($v.tier)'"

Write-Host "`nLaser via FULL-porten (ska se bada)" -ForegroundColor Cyan
$allFull = Invoke-RestMethod "$FULL/api/thoughts" -Headers $H
Check "FULL ser bada nivaerna" ($allFull.Count -ge 2) "fick $($allFull.Count)"
Check "FULL ser valv-innehallet" ([bool]($allFull | Where-Object { $_.tier -eq "vault" })) "ingen valv-rad"

Write-Host "`nLaser via OPPNA porten (far INTE se valvet)" -ForegroundColor Cyan
$allOpen = Invoke-RestMethod "$OPEN/api/thoughts" -Headers $H
Check "OPPEN ser inga valv-rader" (-not ($allOpen | Where-Object { $_.tier -eq "vault" })) "valv lackte ut"
Check "OPPEN ser den oppna raden" ([bool]($allOpen | Where-Object { $_.id -eq $o.id })) "saknar oppen rad"
Check "SUPERHEMLIGT syns aldrig" (-not (($allOpen | ConvertTo-Json -Depth 6) -match "SUPERHEMLIGT")) "hemlighet lackte"

Write-Host "`nDirekt id-uppslag av valv-raden via OPPNA porten" -ForegroundColor Cyan
try {
    Invoke-RestMethod "$OPEN/api/thoughts/$($v.id)" -Method Patch -Headers $H -Body '{"content":"kapad"}'
    Check "OPPEN kan inte rora valv-rad via id" $false "patch gick igenom"
} catch { Check "OPPEN kan inte rora valv-rad via id" $true "" }

Write-Host "`nSkrivforsok till valvet via OPPNA porten" -ForegroundColor Cyan
try {
    Invoke-RestMethod "$OPEN/api/thoughts" -Method Post -Headers $H -Body (@{
        content = "Forsok att smuggla in en hemlighet utifran."; tier = "vault" } | ConvertTo-Json)
    Check "OPPEN nekar vault-skrivning" $false "skrivningen gick igenom"
} catch { Check "OPPEN nekar vault-skrivning" $true "" }

Write-Host "`nStats" -ForegroundColor Cyan
$sFull = Invoke-RestMethod "$FULL/api/stats" -Headers $H
$sOpen = Invoke-RestMethod "$OPEN/api/stats" -Headers $H
Check "FULL raknar fler an OPPEN" ($sFull.total -gt $sOpen.total) "full=$($sFull.total) open=$($sOpen.total)"
Check "OPPEN stats namner inte valv" (-not $sOpen.byTier.vault) "byTier visar valv"

Write-Host "`nAutentisering" -ForegroundColor Cyan
try {
    Invoke-RestMethod "$OPEN/api/thoughts" -Headers @{ Authorization = "Bearer fel-nyckel" }
    Check "fel nyckel nekas" $false "slapptes igenom"
} catch { Check "fel nyckel nekas" $true "" }

Write-Host "`n$pass godkanda, $fail underkanda`n" -ForegroundColor $(if ($fail) { "Red" } else { "Green" })
if ($fail) { exit 1 }
