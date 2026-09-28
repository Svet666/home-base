# Opens an attended launch window for Claire (Codex) and Andrew (Claude) at once.
# Stop both: New-Item .home-base-poller\STOP   (a worker already running finishes first)
# -Until reuses a window's deadline so its queue survives a restart; -WorkerMinutes caps each session.
param([int]$Hours = 4, [string]$Until = '', [int]$WorkerMinutes = 45)
$ErrorActionPreference = 'Stop'
if ($Hours -lt 1 -or $Hours -gt 4) { throw 'Hours must be 1-4 (the poller caps a window at four hours).' }
if ($WorkerMinutes -lt 1 -or $WorkerMinutes -gt 240) { throw 'WorkerMinutes must be 1-240.' }

$repo = Split-Path $PSScriptRoot -Parent
$dir = Join-Path $repo '.home-base-poller'
$stop = Join-Path $dir 'STOP'
if (Test-Path $stop) { Remove-Item $stop }
# A minute short of the cap so the deadline check never trips on clock skew.
$until = if ($Until) { $Until } else { (Get-Date).ToUniversalTime().AddHours($Hours).AddMinutes(-1).ToString('yyyy-MM-ddTHH:mm:ssZ') }
$timeoutMs = $WorkerMinutes * 60000

$hosts = @(
  @{ name = 'claire'; env = '.env.agent'; worker = 'codex'; workspace = $repo; state = 'state.json' },
  @{ name = 'andrew'; env = '.env.andrew'; worker = 'claude'; workspace = (Split-Path $repo -Parent); state = 'andrew\state.json' }
)
foreach ($h in $hosts) {
  $log = Join-Path $dir "$($h.name).log"
  $line = "cmd /c `"set HOME_BASE_ENV_FILE=$repo\$($h.env)&& set HOME_BASE_WORKER=$($h.worker)&& " +
    "set HOME_BASE_WORKSPACE=$($h.workspace)&& set HOME_BASE_POLLER_STATE=$dir\$($h.state)&& " +
    "set HOME_BASE_POLLER_STOP=$stop&& set HOME_BASE_POLLER_WORKER_TIMEOUT_MS=$timeoutMs&& node poller\run.mjs --launch --until $until >> `"$log`" 2>&1`""
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line; CurrentDirectory = $repo }
  if ($r.ReturnValue -ne 0) { throw "Start failed for $($h.name): $($r.ReturnValue)" }
  Write-Output "$($h.name): pid $($r.ProcessId), log $log"
}
Write-Output "Window open until $until UTC. Stop: New-Item '$stop'"
