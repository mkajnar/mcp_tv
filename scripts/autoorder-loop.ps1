# Runs autoorder repeatedly over the current top 50 Bybit perpetuals by 24h turnover.
# Each full pass fetches a fresh top-50 list, then walks it sequentially (autoorder switches the chart
# per symbol, so it cannot run in parallel). Meant to be started hidden via Start-Process; see README.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/autoorder-loop.ps1 [-PauseSeconds 300] [-NoScreenshot]
param(
  [int]$PauseSeconds = 300,       # rest between full passes over the 50 tickers
  [int]$StartDelaySeconds = 0,    # wait before the first pass (keeps the schedule when restarting)
  [switch]$NoScreenshot = $true,  # skip the 5m screenshot (faster, less disk)
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

Set-Location $RepoRoot

function Get-Top50 {
  $json = node -e "fetch('https://api.bybit.com/v5/market/tickers?category=linear').then(r=>r.json()).then(j=>{const l=j.result.list.filter(t=>t.symbol.endsWith('USDT')).sort((a,b)=>b.turnover24h-a.turnover24h).slice(0,50).map(t=>t.symbol);console.log(JSON.stringify(l));})"
  return ($json | ConvertFrom-Json)
}

Write-Output (@{ ts = (Get-Date).ToUniversalTime().ToString("o"); message = "autoorder-loop started"; pause_seconds = $PauseSeconds } | ConvertTo-Json -Compress)
if ($StartDelaySeconds -gt 0) { Start-Sleep -Seconds $StartDelaySeconds }

while ($true) {
  try {
    $symbols = Get-Top50
  } catch {
    Write-Output (@{ ts = (Get-Date).ToUniversalTime().ToString("o"); error = "failed to fetch top 50: $($_.Exception.Message)" } | ConvertTo-Json -Compress)
    Start-Sleep -Seconds 30
    continue
  }
  Write-Output (@{ ts = (Get-Date).ToUniversalTime().ToString("o"); message = "pass start"; count = $symbols.Count } | ConvertTo-Json -Compress)

  foreach ($sym in $symbols) {
    $nodeArgs = @("src/cli/index.js", "order", "auto", "BYBIT:${sym}.P")
    if ($NoScreenshot) { $nodeArgs += "--no-screenshot" }
    try {
      # The CLI writes failures as JSON to stderr; PowerShell 5.1 wraps stderr lines in ErrorRecords — unwrap them
      $out = & node @nodeArgs 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { "$_" }
      } | Out-String
      $parsed = $null
      try { $parsed = $out | ConvertFrom-Json } catch {}
      if ($parsed) {
        $dec = $parsed.decision
        $plan = $parsed.order.plan
        # skip / error results have no decision (pending order or position already there, chart did not switch …)
        $reasons = @($dec.reasons)
        $reason = if ($reasons.Count -gt 0 -and $reasons[-1]) { $reasons[-1] } elseif ($parsed.reason) { $parsed.reason } else { $parsed.error }
        $action = if ($dec) { $dec.action } elseif ($parsed.action) { $parsed.action } else { 'error' }
        Write-Output (@{
          ts = (Get-Date).ToUniversalTime().ToString("o"); symbol = $sym
          action = $action; side = $dec.side; type = $dec.type
          reason = $reason; order_ok = $parsed.order.success
          entry = $plan.entry; sl = $plan.sl; tp = $plan.tp
        } | ConvertTo-Json -Compress)
      } else {
        Write-Output (@{ ts = (Get-Date).ToUniversalTime().ToString("o"); symbol = $sym; raw = $out.Trim() } | ConvertTo-Json -Compress)
      }
    } catch {
      Write-Output (@{ ts = (Get-Date).ToUniversalTime().ToString("o"); symbol = $sym; error = $_.Exception.Message } | ConvertTo-Json -Compress)
    }
  }

  Write-Output (@{ ts = (Get-Date).ToUniversalTime().ToString("o"); message = "pass done, sleeping"; pause_seconds = $PauseSeconds } | ConvertTo-Json -Compress)
  Start-Sleep -Seconds $PauseSeconds
}
