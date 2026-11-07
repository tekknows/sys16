param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^https://')]
  [string]$SupabaseUrl,

  [Parameter(Mandatory = $true)]
  [string]$SupabaseAnonKey,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^DEV-[0-9A-F-]{36}$')]
  [string]$DeviceId,

  [Parameter(Mandatory = $true)]
  [SecureString]$Credential
)

$ErrorActionPreference = 'Stop'

$windowsPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $windowsPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this installer from an elevated PowerShell window.'
}
if ($Credential.Length -lt 40) {
  throw 'The one-time device credential is not valid.'
}

$installDirectory = Join-Path $env:ProgramData 'Mindlock'
$agentPath = Join-Path $installDirectory 'Run-MindlockDeviceAgent.ps1'
$configPath = Join-Path $installDirectory 'device.json'
$entropy = [Text.Encoding]::UTF8.GetBytes('MINDLOCK-DEVICE-AGENT-V1')
$secretPointer = [IntPtr]::Zero
$secretBytes = $null

try {
  Add-Type -AssemblyName System.Security
  $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($Credential)
  $secretBytes = New-Object byte[] ($Credential.Length * 2)
  [Runtime.InteropServices.Marshal]::Copy($secretPointer, $secretBytes, 0, $secretBytes.Length)
  $encryptedBytes = [Security.Cryptography.ProtectedData]::Protect(
    $secretBytes,
    $entropy,
    [Security.Cryptography.DataProtectionScope]::LocalMachine
  )

  New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
  $adminsSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
  $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagation = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl', $inheritance, $propagation, $allow)))
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($adminsSid, 'FullControl', $inheritance, $propagation, $allow)))
  Set-Acl -Path $installDirectory -AclObject $acl

  $sourceAgent = Join-Path $PSScriptRoot 'Run-MindlockDeviceAgent.ps1'
  if (-not (Test-Path -LiteralPath $sourceAgent -PathType Leaf)) {
    throw "Agent script not found: $sourceAgent"
  }
  Copy-Item -LiteralPath $sourceAgent -Destination $agentPath -Force
  $config = @{
    heartbeat_url = "$($SupabaseUrl.TrimEnd('/'))/functions/v1/device-heartbeat"
    anon_key = $SupabaseAnonKey
    device_id = $DeviceId
    credential_protected = [Convert]::ToBase64String($encryptedBytes)
  }
  $config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
  $configAcl = Get-Acl -LiteralPath $configPath
  $configAcl.SetAccessRuleProtection($true, $false)
  $configAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl', $allow)))
  $configAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($adminsSid, 'FullControl', $allow)))
  Set-Acl -LiteralPath $configPath -AclObject $configAcl

  if (-not [Diagnostics.EventLog]::SourceExists('MindlockDeviceAgent')) {
    New-EventLog -LogName Application -Source 'MindlockDeviceAgent'
  }
  $powerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $action = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoProfile -NonInteractive -File `"$agentPath`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName 'MINDLOCK Device Heartbeat' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName 'MINDLOCK Device Heartbeat'
  Write-Host "MINDLOCK device agent installed for $DeviceId."
  Write-Host 'The credential is stored with Windows DPAPI and is not written in plaintext to the configuration file.'
} finally {
  if ($secretPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeGlobalAllocUnicode($secretPointer)
  }
  if ($secretBytes) { [Array]::Clear($secretBytes, 0, $secretBytes.Length) }
  $Credential.Dispose()
}
