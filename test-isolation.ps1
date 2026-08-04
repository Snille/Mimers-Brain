# Verifies the tier boundary: the open listener must not expose vault rows,
# must not accept vault writes, and must not serve a vault row by direct id.
# Also checks that MCP_OPEN_KEY stays confined to /mcp on the open listener.
#
#   .\test-isolation.ps1                                      # localhost, keys from .env
#   .\test-isolation.ps1 -HostName 192.0.2.41 -KeyFile k.txt  # against a deployment
param(
    [string]$HostName = "localhost",
    [string]$KeyFile,
    [string]$OpenKeyFile
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$key = if ($KeyFile) { (Get-Content $KeyFile -Raw).Trim() }
       else { ((Get-Content .env | Select-String '^MCP_ACCESS_KEY=(.*)$').Matches.Groups[1].Value).Trim() }
$H = @{ Authorization = "Bearer $key"; "Content-Type" = "application/json" }
$FULL = "http://${HostName}:8790"
$OPEN = "http://${HostName}:8791"
Write-Host "Testing against $HostName" -ForegroundColor Cyan

$pass = 0; $fail = 0
function Check($name, $ok, $detail) {
    if ($ok) { $script:pass++; Write-Host "  PASS  $name" -ForegroundColor Green }
    else     { $script:fail++; Write-Host "  FAIL  $name -- $detail" -ForegroundColor Red }
}

Write-Host "`nWriting test data through the FULL listener" -ForegroundColor Cyan
$o = Invoke-RestMethod "$FULL/api/thoughts" -Method Post -Headers $H -Body (@{
    content = "Open test note: the test system is reachable on port 8791 through the proxy."
    tier = "open" } | ConvertTo-Json)
$v = Invoke-RestMethod "$FULL/api/thoughts" -Method Post -Headers $H -Body (@{
    content = "VAULT test note: the password for the test system is CANARY-42."
    tier = "vault" } | ConvertTo-Json)
Check "vault write kept tier=vault" ($v.tier -eq "vault") "got '$($v.tier)'"

Write-Host "`nReading through the FULL listener (should see both)" -ForegroundColor Cyan
$allFull = Invoke-RestMethod "$FULL/api/thoughts" -Headers $H
Check "FULL sees both tiers" ($allFull.Count -ge 2) "got $($allFull.Count)"
Check "FULL sees the vault row" ([bool]($allFull | Where-Object { $_.tier -eq "vault" })) "no vault row"

Write-Host "`nReading through the OPEN listener (must NOT see the vault)" -ForegroundColor Cyan
$allOpen = Invoke-RestMethod "$OPEN/api/thoughts" -Headers $H
Check "OPEN sees no vault rows" (-not ($allOpen | Where-Object { $_.tier -eq "vault" })) "vault leaked"
Check "OPEN sees the open row" ([bool]($allOpen | Where-Object { $_.id -eq $o.id })) "open row missing"
Check "the secret never appears" (-not (($allOpen | ConvertTo-Json -Depth 6) -match "CANARY")) "secret leaked"

Write-Host "`nLooking the vault row up by id through the OPEN listener" -ForegroundColor Cyan
try {
    Invoke-RestMethod "$OPEN/api/thoughts/$($v.id)" -Method Patch -Headers $H -Body '{"content":"hijacked"}'
    Check "OPEN cannot touch a vault row by id" $false "the patch went through"
} catch { Check "OPEN cannot touch a vault row by id" $true "" }

Write-Host "`nAttempting a vault write through the OPEN listener" -ForegroundColor Cyan
try {
    Invoke-RestMethod "$OPEN/api/thoughts" -Method Post -Headers $H -Body (@{
        content = "Attempt to smuggle a secret in from outside."; tier = "vault" } | ConvertTo-Json)
    Check "OPEN refuses vault writes" $false "the write went through"
} catch { Check "OPEN refuses vault writes" $true "" }

Write-Host "`nStatistics" -ForegroundColor Cyan
# ConvertFrom-Json's object model is case-insensitive, so an object with keys
# differing only by case (which the metadata extractor used to produce) comes
# back as a raw string instead of an object. Topics are normalised on write now;
# this guard turns a regression into a clear failure rather than an empty total.
# Note -AsHashtable is not available in Windows PowerShell 5.1, so it is avoided.
function Stats($base, $label) {
    $s = Invoke-RestMethod "$base/api/stats" -Headers $H
    if ($s -is [string]) {
        throw "$label /api/stats did not parse as an object - duplicate keys differing only by case?"
    }
    $s
}
$sFull = Stats $FULL "FULL"
$sOpen = Stats $OPEN "OPEN"
Check "FULL counts more than OPEN" ($sFull.total -gt $sOpen.total) "full=$($sFull.total) open=$($sOpen.total)"
Check "OPEN stats do not mention the vault" (-not $sOpen.byTier.vault) "byTier exposes the vault"

Write-Host "`nAuthentication" -ForegroundColor Cyan
try {
    Invoke-RestMethod "$OPEN/api/thoughts" -Headers @{ Authorization = "Bearer wrong-key" }
    Check "a wrong key is refused" $false "it was let through"
} catch { Check "a wrong key is refused" $true "" }

Write-Host "`nURL key" -ForegroundColor Cyan
# MCP_OPEN_KEY buys convenience for clients that cannot send a header, and the
# price is that it travels somewhere visible. These checks are the fence around
# that: it must work on /mcp on the open listener and nowhere else at all.
$openKey = if ($OpenKeyFile) { (Get-Content $OpenKeyFile -Raw).Trim() }
           else {
               $m = Get-Content .env -ErrorAction SilentlyContinue | Select-String '^MCP_OPEN_KEY=(.*)$'
               if ($m) { $m.Matches.Groups[1].Value.Trim() } else { "" }
           }

if (-not $openKey) {
    Write-Host "  SKIP  MCP_OPEN_KEY not set" -ForegroundColor DarkGray
} else {
    $mcpH = @{ "Content-Type" = "application/json"; Accept = "application/json, text/event-stream" }
    $rpc  = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

    try {
        Invoke-RestMethod "$OPEN/mcp?key=$openKey" -Method Post -Headers $mcpH -Body $rpc | Out-Null
        Check "OPEN /mcp accepts the URL key" $true ""
    } catch { Check "OPEN /mcp accepts the URL key" $false $_.Exception.Message }

    # The one that matters: the vault listener must not know this key exists.
    try {
        Invoke-RestMethod "$FULL/mcp?key=$openKey" -Method Post -Headers $mcpH -Body $rpc | Out-Null
        Check "FULL /mcp refuses the URL key" $false "it was let through"
    } catch { Check "FULL /mcp refuses the URL key" $true "" }

    try {
        Invoke-RestMethod "$OPEN/api/thoughts?key=$openKey" | Out-Null
        Check "OPEN /api ignores the URL key" $false "it was let through"
    } catch { Check "OPEN /api ignores the URL key" $true "" }

    try {
        Invoke-RestMethod "$OPEN/mcp?key=wrong-key" -Method Post -Headers $mcpH -Body $rpc | Out-Null
        Check "a wrong URL key is refused" $false "it was let through"
    } catch { Check "a wrong URL key is refused" $true "" }
}

Write-Host "`nCleaning up test data" -ForegroundColor Cyan
foreach ($id in @($v.id, $o.id)) {
    try { Invoke-RestMethod "$FULL/api/thoughts/$id" -Method Delete -Headers $H | Out-Null } catch {}
}
$left = Invoke-RestMethod "$FULL/api/thoughts" -Headers $H | Where-Object { $_.id -in @($v.id, $o.id) }
Check "test rows removed" (-not $left) "test rows still present"

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { "Red" } else { "Green" })
if ($fail) { exit 1 }
