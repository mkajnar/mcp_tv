/**
 * Keep Windows awake while a long-running loop (tv order trail --watch) runs.
 *
 * On Modern Standby laptops "display off" is the standby entry, and in standby Windows suspends desktop apps —
 * the trail loop, autoorder and TradingView stop until the machine wakes. A hidden PowerShell helper holds
 * SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) and exits (releasing the
 * request) once this process is gone. Manual sleep (power button, lid, Start → Sleep) still wins.
 */
import { spawn } from 'node:child_process';

const ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x1, ES_DISPLAY_REQUIRED = 0x2;

/** Start the helper; returns its pid (null on other platforms). */
export function keepAwake() {
  if (process.platform !== 'win32') return null;
  const flags = (ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) >>> 0;
  const script = [
    `Add-Type -Namespace KeepAwake -Name Native -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'`,
    `[void][KeepAwake.Native]::SetThreadExecutionState(${flags})`,
    `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 30 }`,
  ].join('\n');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: 'ignore' });
  child.on('error', () => { /* no powershell: nothing to hold */ });
  child.unref();
  return child.pid ?? null;
}
