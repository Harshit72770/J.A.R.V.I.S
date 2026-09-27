# J.A.R.V.I.S media worker — laptop system volume + screen brightness.
#
# Stays resident while commands are flowing so the Core Audio interop is
# compiled ONCE and every command answers in milliseconds (a fresh PowerShell
# per command would cost ~1.5s each). The bridge kills it after 2 minutes idle.
#
# Protocol (stdin/stdout, one JSON object per line):
#   in : {"id":1,"device":"volume","action":"set","value":50}
#   out: {"id":1,"ok":true,"volume":50,"muted":false,"brightness":70,"error":null}

$ErrorActionPreference = 'Stop'

$csharp = @"
using System;
using System.Runtime.InteropServices;

public static class CoreAudio
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                     [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        int OpenPropertyStore(int access, out IntPtr props);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    // Vtable order must match endpointvolume.h exactly.
    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr notify);
        int UnregisterControlChangeNotify(IntPtr notify);
        int GetChannelCount(out uint count);
        int SetMasterVolumeLevel(float levelDb, Guid eventContext);
        int SetMasterVolumeLevelScalar(float level, Guid eventContext);
        int GetMasterVolumeLevel(out float levelDb);
        int GetMasterVolumeLevelScalar(out float level);
        int SetChannelVolumeLevel(uint channel, float levelDb, Guid eventContext);
        int SetChannelVolumeLevelScalar(uint channel, float level, Guid eventContext);
        int GetChannelVolumeLevel(uint channel, out float levelDb);
        int GetChannelVolumeLevelScalar(uint channel, out float level);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid eventContext);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
        int GetVolumeStepInfo(out uint step, out uint stepCount);
        int VolumeStepUp(Guid eventContext);
        int VolumeStepDown(Guid eventContext);
        int QueryHardwareSupport(out uint mask);
        int GetVolumeRange(out float min, out float max, out float step);
    }

    private static IAudioEndpointVolume Endpoint()
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDevice device;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out device));
        Guid iid = typeof(IAudioEndpointVolume).GUID;
        object o;
        Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out o));
        return (IAudioEndpointVolume)o;
    }

    // Public surface is plain (no out/ref) so PowerShell can call it directly.
    public static float GetVolume()
    {
        float v;
        Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v));
        return v;
    }
    public static void SetVolume(float v)
    {
        Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(v, Guid.Empty));
    }
    public static bool GetMute()
    {
        bool m;
        Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m));
        return m;
    }
    public static void SetMute(bool m)
    {
        Marshal.ThrowExceptionForHR(Endpoint().SetMute(m, Guid.Empty));
    }
}
"@

Add-Type -TypeDefinition $csharp

# ─── Brightness (internal laptop panel via WMI) ─────────────────────────────
function Get-BrightnessValue {
    try {
        $monitors = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop)
        $active = $monitors | Where-Object { $_.Active } | Select-Object -First 1
        if (-not $active) { $active = $monitors | Select-Object -First 1 }
        if ($active) { return [int]$active.CurrentBrightness }
    } catch { }
    return $null
}

function Set-BrightnessValue([int]$pct) {
    if ($pct -lt 0) { $pct = 0 }
    if ($pct -gt 100) { $pct = 100 }
    $methods = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop)
    if (-not $methods -or $methods.Count -eq 0) {
        throw 'This display does not support software brightness control.'
    }
    foreach ($m in $methods) {
        Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness `
            -Arguments @{ Timeout = [uint32]1; Brightness = [byte]$pct } -ErrorAction Stop | Out-Null
    }
    # The panel reports the new value a moment later.
    Start-Sleep -Milliseconds 300
}

# ─── State read (always reported, even after a failed action) ───────────────
function Get-State {
    $vol = $null; $mute = $null; $volErr = $null
    try { $vol = [int][Math]::Round([double][CoreAudio]::GetVolume() * 100) }
    catch { $volErr = $_.Exception.Message }
    if ($null -eq $vol) {
        try { $mute = [bool][CoreAudio]::GetMute() } catch { }
    } else {
        try { $mute = [bool][CoreAudio]::GetMute() } catch { $volErr = $_.Exception.Message }
    }
    $bri = Get-BrightnessValue
    [pscustomobject]@{ volume = $vol; muted = $mute; brightness = $bri }
}

function Handle($req) {
    $device = "$($req.device)"
    $action = "$($req.action)"
    $err = $null

    try {
        if ($device -eq 'volume') {
            switch ($action) {
                'get' { }
                'set' {
                    $p = [int]$req.value
                    if ($p -lt 0) { $p = 0 }
                    if ($p -gt 100) { $p = 100 }
                    [CoreAudio]::SetVolume([float]($p / 100.0))
                }
                'up' {
                    $cur = [double][CoreAudio]::GetVolume()
                    $next = $cur + 0.05
                    if ($next -gt 1.0) { $next = 1.0 }
                    [CoreAudio]::SetVolume([float]$next)
                    if ([CoreAudio]::GetMute()) { [CoreAudio]::SetMute($false) }
                }
                'down' {
                    $cur = [double][CoreAudio]::GetVolume()
                    $next = $cur - 0.05
                    if ($next -lt 0.0) { $next = 0.0 }
                    [CoreAudio]::SetVolume([float]$next)
                    if ([CoreAudio]::GetMute()) { [CoreAudio]::SetMute($false) }
                }
                'mute' { [CoreAudio]::SetMute($true) }
                'unmute' { [CoreAudio]::SetMute($false) }
                'toggle' { [CoreAudio]::SetMute(-not [CoreAudio]::GetMute()) }
                default { throw "Unknown volume action '$action'." }
            }
        }
        elseif ($device -eq 'brightness') {
            switch ($action) {
                'get' { }
                'set' { Set-BrightnessValue ([int]$req.value) }
                'up' {
                    $cur = Get-BrightnessValue
                    if ($null -eq $cur) { throw 'This display does not report its brightness.' }
                    Set-BrightnessValue ([Math]::Min(100, $cur + 10))
                }
                'down' {
                    $cur = Get-BrightnessValue
                    if ($null -eq $cur) { throw 'This display does not report its brightness.' }
                    Set-BrightnessValue ([Math]::Max(0, $cur - 10))
                }
                default { throw "Unknown brightness action '$action'." }
            }
        }
        else {
            throw "Unknown device '$device'."
        }
    } catch {
        $err = $_.Exception.Message
    }

    $state = Get-State
    [pscustomobject]@{
        id         = $req.id
        ok         = ($null -eq $err)
        volume     = $state.volume
        muted      = $state.muted
        brightness = $state.brightness
        error      = $err
    }
}

# ─── Command loop: one JSON line in, one JSON line out ──────────────────────
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }   # bridge closed stdin → exit
    if ($line.Trim().Length -eq 0) { continue }

    $id = $null
    $resp = $null
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        $resp = Handle $req
    } catch {
        $resp = [pscustomobject]@{
            id = $id; ok = $false; volume = $null; muted = $null
            brightness = $null; error = $_.Exception.Message
        }
    }

    [Console]::Out.WriteLine((ConvertTo-Json $resp -Compress))
    [Console]::Out.Flush()
}
