# Mantém o adaptador claude-cli (claude -p como API OpenAI) rodando em 127.0.0.1:8320.
# Reinicia o node se ele cair, com espera crescente. Iniciado pela tarefa agendada no logon.
$ErrorActionPreference = "Continue"
Start-Transcript -Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'logs\wrapper.transcript.log') -Append | Out-Null
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:CLAUDE_BRIDGE_CONFIG = Join-Path $Here "config.json"
$mutex = New-Object Threading.Mutex($false, "Local\CliproxyClaudeCliAdapter")
try { if (-not $mutex.WaitOne(0)) { exit } } catch [Threading.AbandonedMutexException] {}
$log = Join-Path $Here "logs"; New-Item -ItemType Directory -Force $log | Out-Null
$delay = 2
while ($true) {
  $stamp = Get-Date -Format yyyyMMdd
  $p = Start-Process -FilePath "C:\Program Files\nodejs\node.exe" -ArgumentList "`"$(Join-Path $Here 'server.mjs')`"" -WorkingDirectory $Here -WindowStyle Hidden -PassThru `
       -RedirectStandardOutput (Join-Path $log "adapter-$stamp.log") -RedirectStandardError (Join-Path $log "adapter-$stamp.err.log")
  $started = Get-Date
  $p.WaitForExit()
  if (((Get-Date) - $started).TotalMinutes -gt 5) { $delay = 2 } else { $delay = [Math]::Min($delay * 2, 60) }
  Get-ChildItem $log -Filter "adapter-*.log" | Where-Object LastWriteTime -lt (Get-Date).AddDays(-14) | Remove-Item -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds $delay
}


