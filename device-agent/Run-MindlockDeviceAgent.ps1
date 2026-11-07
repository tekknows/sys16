$ErrorActionPreference = 'Stop'
$configPath = Join-Path $env:ProgramData 'Mindlock\device.json'
$entropy = [Text.Encoding]::UTF8.GetBytes('MINDLOCK-DEVICE-AGENT-V1')
$lastState = $null
$source = 'MindlockDeviceAgent'

function Write-AgentState([string]$State, [string]$Message) {
  if ($script:lastState -eq $State) { return }
  $script:lastState = $State
  try {
    Write-EventLog -LogName Application -Source $script:source `
      -EntryType $(if ($State -eq 'Online') { 'Information' } else { 'Warning' }) `
      -EventId 4100 -Message $Message
  } catch {
    Write-Output $Message
  }
}

Add-Type -AssemblyName System.Security
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$encrypted = [Convert]::FromBase64String($config.credential_protected)
$credentialBytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $encrypted,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::LocalMachine
)
$credential = [Text.Encoding]::Unicode.GetString($credentialBytes)
[Array]::Clear($credentialBytes, 0, $credentialBytes.Length)

try {
  while ($true) {
    try {
      $body = @{
        device_id = $config.device_id
        credential = $credential
      } | ConvertTo-Json -Compress
      Invoke-RestMethod -Method Post -Uri $config.heartbeat_url -ContentType 'application/json' `
        -Headers @{ apikey = $config.anon_key } -Body $body -TimeoutSec 20 | Out-Null
      Write-AgentState 'Online' "Device $($config.device_id) heartbeat accepted."
    } catch {
      $statusCode = $_.Exception.Response.StatusCode
      if ($statusCode -eq 401) {
        Write-AgentState 'Unauthorized' "Device $($config.device_id) registration was rejected. Contact IT to re-register it."
      } else {
        Write-AgentState 'Offline' "Device $($config.device_id) could not send a heartbeat. The connection will be retried."
      }
    }
    Start-Sleep -Seconds 60
  }
} finally {
  $credential = $null
}
