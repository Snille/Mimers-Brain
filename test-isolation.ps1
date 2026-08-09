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
       elseif ($env:MCP_ACCESS_KEY) { $env:MCP_ACCESS_KEY.Trim() }
       elseif (Test-Path .env) { ((Get-Content .env | Select-String '^MCP_ACCESS_KEY=(.*)$').Matches.Groups[1].Value).Trim() }
       else { "" } # isolated local test instance with authentication disabled
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
if (-not $key) { Write-Host "  SKIP  authentication disabled on this test instance" -ForegroundColor DarkGray }
else {
    try {
        Invoke-RestMethod "$OPEN/api/thoughts" -Headers @{ Authorization = "Bearer wrong-key" }
        Check "a wrong key is refused" $false "it was let through"
    } catch { Check "a wrong key is refused" $true "" }
}

Write-Host "`nThe OpenAPI surface" -ForegroundColor Cyan
# /openapi.json and /tools/* are a second door onto the same memory, so the tier
# boundary has to hold there too - and the document itself must not advertise a
# capability the listener does not have.
$specOpen = Invoke-RestMethod "$OPEN/openapi.json"
$specFull = Invoke-RestMethod "$FULL/openapi.json"
$openPaths = $specOpen.paths.PSObject.Properties.Name
$fullPaths = $specFull.paths.PSObject.Properties.Name
Check "OPEN spec hides delete_thought" ($openPaths -notcontains "/tools/delete_thought") "it was listed"
Check "FULL spec offers delete_thought" ($fullPaths -contains "/tools/delete_thought") "it was missing"
Check "OPEN spec hides supersede_thought" ($openPaths -notcontains "/tools/supersede_thought") "it was listed"
Check "FULL spec offers supersede_thought" ($fullPaths -contains "/tools/supersede_thought") "it was missing"

$tierEnum = $specOpen.paths."/tools/capture_thought".post.requestBody.content."application/json".schema.properties.tier.enum
Check "OPEN spec offers no vault tier" ($tierEnum -notcontains "vault") "vault was offered"
$captureDescription = $specFull.paths."/tools/capture_thought".post.description
Check "capture guidance forbids raw secrets" ($captureDescription -match "never store raw") "safety rule missing"
Check "capture guidance does not invite passwords" ($captureDescription -notmatch "vault \(keys, passwords, tokens\)") "old unsafe wording remains"

Write-Host "`nNavigable supersession and metadata v2" -ForegroundColor Cyan
$historyOld = Invoke-RestMethod "$FULL/api/thoughts" -Method Post -Headers $H -Body (@{
    content = "Luba integration test memory."; tier = "open"
    metadata = @{ type = "task"; topics = @("Networking"); people = @("Erik", "Luba") }
} | ConvertTo-Json -Depth 5)
Check "legacy task gets kind=task" ($historyOld.metadata.kind -eq "task") "got '$($historyOld.metadata.kind)'"
Check "new tasks default to pending" ($historyOld.metadata.task_status -eq "pending") "got '$($historyOld.metadata.task_status)'"
Check "topic aliases are canonical" ($historyOld.metadata.topics -contains "network") "network missing"
Check "Luba is not a person" ($historyOld.metadata.people -notcontains "Luba") "Luba remained under people"
Check "Luba and Sleipner are systems" (($historyOld.metadata.systems -contains "Luba") -and
    ($historyOld.metadata.systems -contains "Sleipner")) "system aliases missing"

$historyNew = Invoke-RestMethod "$FULL/api/thoughts/supersede" -Method Post -Headers $H -Body (@{
    old_ids = @($historyOld.id); content = "Current integration test replacement."; tier = "open"
    metadata = @{ kind = "fact"; topics = @("network") }
} | ConvertTo-Json -Depth 5)
$currentRows = Invoke-RestMethod "$FULL/api/thoughts" -Headers $H
$allRows = Invoke-RestMethod "$FULL/api/thoughts?lifecycle=all" -Headers $H
Check "superseded row is hidden by default" (-not ($currentRows | Where-Object { $_.id -eq $historyOld.id })) "old row visible"
Check "replacement is current" ([bool]($currentRows | Where-Object { $_.id -eq $historyNew.id })) "replacement missing"
Check "superseded history remains readable" ([bool]($allRows | Where-Object { $_.id -eq $historyOld.id })) "old row disappeared"
$historyFetched = Invoke-RestMethod "$FULL/api/thoughts/$($historyOld.id)" -Headers $H
Check "old row is marked superseded" ($historyFetched.metadata.lifecycle -eq "superseded") "got '$($historyFetched.metadata.lifecycle)'"
Check "history relation is navigable" ($historyFetched.relations.Count -eq 1) "relation missing"

try {
    Invoke-RestMethod "$OPEN/tools/capture_thought" -Method Post -Headers $H -Body (@{
        content = "Attempt to smuggle a secret in through OpenAPI."; tier = "vault" } | ConvertTo-Json) | Out-Null
    Check "OPEN /tools refuses vault writes" $false "the write went through"
} catch { Check "OPEN /tools refuses vault writes" $true "" }

try {
    Invoke-RestMethod "$OPEN/tools/fetch_thought" -Method Post -Headers $H -Body (@{ id = $v.id } | ConvertTo-Json) | Out-Null
    Check "OPEN /tools cannot fetch a vault row" $false "the row came back"
} catch { Check "OPEN /tools cannot fetch a vault row" $true "" }

if ($key) {
    try {
        Invoke-RestMethod "$OPEN/tools/thought_stats" -Method Post -Body '{}' -Headers @{
            Authorization = "Bearer wrong-key"; "Content-Type" = "application/json" } | Out-Null
        Check "/tools refuses a wrong key" $false "it was let through"
    } catch { Check "/tools refuses a wrong key" $true "" }
}

# The document is public on purpose - names and argument schemas, nothing more -
# so a client can be configured before it has a key. Nothing else may be.
try {
    Invoke-RestMethod "$OPEN/openapi.json" | Out-Null
    Check "/openapi.json needs no key" $true ""
} catch { Check "/openapi.json needs no key" $false $_.Exception.Message }

Write-Host "`nURL key" -ForegroundColor Cyan
# MCP_OPEN_KEY buys convenience for clients that cannot send a header, and the
# price is that it travels somewhere visible. These checks are the fence around
# that: it must work on /mcp on the open listener and nowhere else at all.
$openKey = if ($OpenKeyFile) { (Get-Content $OpenKeyFile -Raw).Trim() }
           elseif ($env:MCP_OPEN_KEY) { $env:MCP_OPEN_KEY.Trim() }
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

Write-Host "`nThe connection guide" -ForegroundColor Cyan
$cFull = Invoke-RestMethod "$FULL/api/connect" -Headers $H
$cOpen = Invoke-RestMethod "$OPEN/api/connect" -Headers $H

# The vault key must never be served through the listener that faces the proxy.
# Authelia gates that page, but the key would still travel out of the house and
# into a browser cache on every visit - and it is the one credential that opens
# the vault on the LAN.
Check "OPEN /api/connect withholds the vault key" ([string]::IsNullOrEmpty($cOpen.accessKey)) "it was handed out"
if ($key) {
    Check "FULL /api/connect provides the vault key" (-not [string]::IsNullOrEmpty($cFull.accessKey)) "nothing to copy"
}
Check "OPEN /api/connect hides delete_thought" ($cOpen.tools.name -notcontains "delete_thought") "it was listed"

Write-Host "`nUsage statistics" -ForegroundColor Cyan
$uFull = Invoke-RestMethod "$FULL/api/usage" -Headers $H
$uOpen = Invoke-RestMethod "$OPEN/api/usage" -Headers $H

# Traffic on the vault listener must not be countable from outside either: a
# call count that jumps while the public page shows nothing is still a signal
# that something else exists.
Check "OPEN usage counts only open-listener traffic" ($uOpen.calls.total -le $uFull.calls.total) "OPEN reported more than FULL"
Check "OPEN usage counts only open-tier memories" ($uOpen.memories.total -lt $uFull.memories.total) "OPEN saw every memory"

# The usage log is a traffic light, not a transcript. If a query string ever
# reached it, a vault search would be readable from the open listener.
$raw = (Invoke-WebRequest "$OPEN/api/usage" -Headers $H).Content
Check "usage statistics contain no memory content" ($raw -notmatch "CANARY") "the secret appeared in the statistics"

Write-Host "`nCleaning up test data" -ForegroundColor Cyan
foreach ($id in @($historyNew.id, $historyOld.id, $v.id, $o.id)) {
    try { Invoke-RestMethod "$FULL/api/thoughts/$id" -Method Delete -Headers $H | Out-Null } catch {}
}
$left = Invoke-RestMethod "$FULL/api/thoughts?lifecycle=all" -Headers $H |
    Where-Object { $_.id -in @($historyNew.id, $historyOld.id, $v.id, $o.id) }
Check "test rows removed" (-not $left) "test rows still present"

Write-Host "`n$pass passed, $fail failed`n" -ForegroundColor $(if ($fail) { "Red" } else { "Green" })
if ($fail) { exit 1 }
