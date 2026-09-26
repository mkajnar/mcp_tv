<#
    launch-tv-cdp.ps1
    Spustí TradingView Desktop (Store/Appx build) s Chrome DevTools Protocol
    na portu 9222 tak, aby se k němu připojil TradingView MCP server.

    Řeší:
      - Electron single-instance lock (zabije běžící instanci => flag se uplatní)
      - mezeru v "Program Files" (8.3 short path)
      - náhodný blok od Bitdefenderu (retry launch + poll portu)

    Použití:   .\launch-tv-cdp.ps1
               .\launch-tv-cdp.ps1 -Port 9222
    Nemusí běžet jako admin.
#>

[CmdletBinding()]
param(
    [int]$Port = 9222,
    [int]$TimeoutSec = 30
)

$ErrorActionPreference = 'Stop'

# Dynamicky najdi exe přes Appx balíček (přežije auto-update / změnu verze) - launcher beze změny
$pkg = Get-AppxPackage *TradingView* | Select-Object -First 1
$Exe = if ($pkg) { Join-Path $pkg.InstallLocation "TradingView.exe" } else { "" }

function Test-CdpPort {
    param([int]$P)
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$P/json/version" -UseBasicParsing -TimeoutSec 3
        return $r.Content
    } catch {
        return $null
    }
}

Write-Host "[*] Kontrola, zda CDP port $Port už neběží..." -ForegroundColor Cyan
$existing = Test-CdpPort -P $Port
if ($existing) {
    Write-Host "[OK] CDP už běží na portu $Port. Není co dělat." -ForegroundColor Green
    $existing
    return
}

if (-not (Test-Path $Exe)) {
    Write-Host "[X] TradingView.exe nenalezen na: $Exe" -ForegroundColor Red
    Write-Host "    Najdi přes: Get-AppxPackage *TradingView*" -ForegroundColor Yellow
    exit 1
}

# 1) Zabij VŠECHNY běžící instance (jinak single-instance lock zahodí náš flag)
Write-Host "[*] Zabíjím běžící TradingView procesy..." -ForegroundColor Cyan
Get-Process TradingView -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# 2) Clean launch s CDP flagem; retry kvůli náhodnému Bitdefender blokU
$launched = $false
for ($i = 1; $i -le 3; $i++) {
    try {
        Write-Host "[*] Launch pokus $i s --remote-debugging-port=$Port ..." -ForegroundColor Cyan
        Start-Process -FilePath $Exe -ArgumentList "--remote-debugging-port=$Port" -ErrorAction Stop
        $launched = $true
        break
    } catch {
        Write-Host "    Pokus $i selhal (možná Bitdefender): $($_.Exception.Message)" -ForegroundColor Yellow
        Start-Sleep -Seconds 2
    }
}

if (-not $launched) {
    Write-Host "[X] Launch se nepovedl ani po 3 pokusech. Bitdefender pravděpodobně blokuje spawn." -ForegroundColor Red
    Write-Host "    Workaround: Bitdefender -> Ochrana -> Pozastavit Bitdefender Shield, pak spusť znovu." -ForegroundColor Yellow
    exit 1
}

# 3) Poll portu, dokud CDP nenaběhne
Write-Host "[*] Čekám na CDP port (max ${TimeoutSec}s)..." -ForegroundColor Cyan
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    $ver = Test-CdpPort -P $Port
    if ($ver) {
        Write-Host "[OK] CDP nabehl na portu ${Port}:" -ForegroundColor Green
        $ver
        Write-Host "`n[HOTOVO] Teď v Claude Code spusť: /mcp  nebo  tv_health_check" -ForegroundColor Green
        return
    }
    Start-Sleep -Milliseconds 1500
}

Write-Host "[X] CDP port $Port nenaběhl do ${TimeoutSec}s." -ForegroundColor Red
Write-Host "    TradingView běží? Zkus zvýšit -TimeoutSec, nebo zkontroluj Bitdefender." -ForegroundColor Yellow
exit 1
