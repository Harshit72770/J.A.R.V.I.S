# J.A.R.V.I.S — UI Automation worker (bridge/ui-worker.ps1)
# =========================================================
# Resident PowerShell worker that drives the USER'S OWN running Chrome/Edge
# session through Windows UI Automation (UIA) — no puppeteer, no CDP, no
# debug port, no second Chrome process ever. JSON-lines protocol with the
# exact same lifecycle as bridge/media-worker.ps1: one JSON object per line
# in, one JSON object per line out; when the bridge closes stdin we exit.
#
# ops:
#   ping                                   -> {ok}
#   state {hintTitle?, hintVideoId?}       -> {ok, chrome, track?, playing?, watch?}
#   findUrl {url, captchaSearch?}          -> {ok, found, captcha, title, hwnd}
#   findYoutube {}                         -> {ok, found, hwnd?, title?, url?}
#   toolbar {action, hwnd?}                -> back|forward|reload|current|close
#   player {mode, key?, expect?, ...hints}  -> mode: invoke | key
#                                             (expect = regex the button name
#                                              must match — direction check)
#   navOmnibox {url, hwnd?, ...hints}      -> {ok}   (hwnd = navigate the
#                                             window's selected tab directly)
#   closeHint {...hints}                   -> {ok, closed}
#
# session-reuse rules encoded here:
#   * a "chrome window" = Chrome_WidgetWin_1 with an omnibox Edit named
#     "Address and search bar" (this excludes Electron windows such as the
#     OpenCode app, which share the same class name);
#   * window Name = selected tab title + " - Audio playing" + " - Google
#     Chrome"; tab-strip TabItem Names carry " - Memory usage - NNN MB";
#     Clean-Title strips every known suffix before matching;
#   * the renderer of an UNSELECTED tab is not in the UIA tree -> reads for
#     such tabs are strip-only (title + audio flag), never a seek slider;
#   * never solves/bypasses anything: Google /sorry/ pages are only REPORTED.
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -MemberDefinition `
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);' `
  -Name U32 -Namespace Jk

$script:Root = [System.Windows.Automation.AutomationElement]::RootElement
$script:ClsCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty,
  'Chrome_WidgetWin_1')

# ── small helpers ───────────────────────────────────────────────────────────
function Read-Prop($el, $prop) {
  try { return $el.Current.$prop } catch { return $null }
}

function Clean-Title([string]$t) {
  if (-not $t) { return '' }
  $s = $t
  $s = $s -replace ' - Memory usage - \d+(\.\d+)? (KB|MB|GB)$', ''
  $s = $s -replace ' - Audio playing$', ''
  $s = $s -replace ' - Google Chrome$', ''
  $s = $s -replace ' - YouTube$', ''
  return $s.Trim()
}

# Case-insensitive bidirectional substring match (IndexOf — never -like, so
# titles containing ( ) [ ] * cannot break matching).
function Title-Match([string]$a, [string]$b) {
  if (-not $a -or -not $b) { return $false }
  $A = $a.Trim(); $B = $b.Trim()
  if ($A.Length -lt 4 -or $B.Length -lt 4) { return $false }
  return ($A.IndexOf($B, [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
         ($B.IndexOf($A, [StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Norm-Url([string]$u) {
  $s = "$u".Trim().ToLowerInvariant()
  $s = $s -replace '^https?://', ''
  $s = $s -replace '^www\.', ''
  $s = $s.TrimEnd('/')
  return $s
}

function Test-Watch([string]$u) {
  if (-not $u) { return $false }
  $s = "$u"
  return ($s.IndexOf('youtube.com/watch', [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
         ($s.IndexOf('youtu.be/', [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
         ($s.IndexOf('youtube.com/shorts', [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
         ($s.IndexOf('youtube.com/live', [StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Test-Captcha([string]$u, [string]$title) {
  $s = "$u $title"
  return ($s.IndexOf('/sorry/', [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
         ($s.IndexOf('unusual traffic', [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
         ($s.IndexOf('recaptcha', [StringComparison]::OrdinalIgnoreCase) -ge 0)
}

# ── window / omnibox / tab-strip access ─────────────────────────────────────
# Returns wrappers @{ win; omni; hwnd } for every real browser window
# (foreground first, then z-order as UIA reports it).
function Get-ChromeWins {
  $fg = [Jk.U32]::GetForegroundWindow()
  $out = @(); $fgw = $null
  foreach ($w in $script:Root.FindAll(
      [System.Windows.Automation.TreeScope]::Children, $script:ClsCond)) {
    $omniCond = New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Edit)),
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        'Address and search bar')))
    $omni = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $omniCond)
    if (-not $omni) { continue }   # Electron/app windows: no omnibox -> not Chrome
    $item = @{ win = $w; omni = $omni; hwnd = [int]$w.Current.NativeWindowHandle }
    if ([int]$w.Current.NativeWindowHandle -eq [int]$fg) { $fgw = $item } else { $out += $item }
  }
  if ($fgw) { $out = @($fgw) + $out }
  return ,$out
}

function Read-Omnibox($w) {
  try {
    $p = $w.omni.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return [string]$p.Current.Value
  } catch { return $null }
}

# Fresh omnibox lookup. Chrome recreates its omnibox element when ^l focuses
# it (and references captured at op start can go stale), so navigation
# re-finds it right before every SetValue/read instead of trusting a cache.
function Get-Omni($win) {
  $c = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Edit)),
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty,
      'Address and search bar')))
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
}

function Read-Omni($el) {
  if (-not $el) { return $null }
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return [string]$p.Current.Value
  } catch { return $null }
}

# Bring a window to the REAL foreground before any SendKeys. A background
# process calling SetForegroundWindow alone is often ignored by Windows
# (foreground lock) and the keys would land in whatever window is actually
# visible — so verify, and use the standard ALT-tap unlock on failure.
# Returns $true only when the target window really is foreground.
function Focus-Win([int]$h) {
  $p = [IntPtr]$h
  if ([Jk.U32]::IsIconic($p)) { [Jk.U32]::ShowWindow($p, 9) | Out-Null }  # SW_RESTORE
  [Jk.U32]::SetForegroundWindow($p) | Out-Null
  Start-Sleep -Milliseconds 120
  if ([Jk.U32]::GetForegroundWindow() -eq $p) { return $true }
  # ALT down/up grants foreground permission (classic Win32 workaround)
  [Jk.U32]::keybd_event(0x12, 0, 0, 0)
  [Jk.U32]::keybd_event(0x12, 0, 2, 0)
  [Jk.U32]::SetForegroundWindow($p) | Out-Null
  Start-Sleep -Milliseconds 150
  return ([Jk.U32]::GetForegroundWindow() -eq $p)
}

function Get-Strip($win) {
  $c = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Tab)
  $strip = $null
  foreach ($t in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c)) {
    if ($t.Current.AutomationId -eq '') { $strip = $t }   # '' = real strip, 'chips' = page chips
  }
  return $strip
}

function Get-TabItems($strip) {
  $out = @()
  if (-not $strip) { return ,$out }
  foreach ($e in $strip.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($e.Current.ControlType.ProgrammaticName -eq 'ControlType.TabItem') { $out += $e }
  }
  return ,$out
}

function Get-SelectedTab($items) {
  foreach ($ti in $items) {
    try {
      $p = $ti.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      if ($p.Current.IsSelected) { return $ti }
    } catch { }
  }
  return $null
}

function Get-SeekSlider($win) {
  $c = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, 'Seek slider')
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
}

# Only the (k)-suffixed player buttons are ever invoked — bare 'Play' names
# exist elsewhere on the page (shelves, Shorts) and must never be pressed.
function Get-PlayerBtn($win) {
  $bt = [System.Windows.Automation.ControlType]::Button
  foreach ($n in @('Pause (k)', 'Play (k)', 'Replay (k)', 'Replay')) {
    $c = New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $bt)),
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $n)))
    $b = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
    if ($b) { return $b }
  }
  return $null
}

# Toolbar Back/Forward/Reload: same row as the omnibox, on its left side.
function Get-ToolBtn($w, [string]$name) {
  $bt = [System.Windows.Automation.ControlType]::Button
  $c = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $bt)),
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, $name)))
  try { $orct = $w.omni.Current.BoundingRectangle } catch { return $null }
  foreach ($b in $w.win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c)) {
    try { $r = $b.Current.BoundingRectangle } catch { continue }
    if ($r.IsEmpty) { continue }
    if ([math]::Abs($r.Top - $orct.Top) -lt 60 -and $r.Right -le ($orct.Left + 40)) { return $b }
  }
  return $null
}

function Find-CloseBtn($strip, $tabItem) {
  $bt = [System.Windows.Automation.ControlType]::Button
  $c = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $bt)),
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::NameProperty, 'Close')))
  $b = $tabItem.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
  if ($b) { return $b }
  try { $trect = $tabItem.Current.BoundingRectangle } catch { return $null }
  foreach ($b in $strip.FindAll([System.Windows.Automation.TreeScope]::Descendants, $c)) {
    try { $r = $b.Current.BoundingRectangle } catch { continue }
    if ($r.IsEmpty) { continue }
    if ($r.Left -ge ($trect.Left - 4) -and $r.Right -le ($trect.Right + 4) -and
        $r.Top -ge ($trect.Top - 4) -and $r.Bottom -le ($trect.Bottom + 4)) { return $b }
  }
  return $null
}

# ── track object ────────────────────────────────────────────────────────────
# $selected: reads slider+button (renderer is in the tree only for a
# window's SELECTED tab); unselected tabs get strip-only info.
function New-Track($w, $url, $title, [bool]$audio, [bool]$selected) {
  $pos = $null; $dur = $null; $btn = $null
  if ($selected) {
    $sl = Get-SeekSlider $w.win
    if ($sl) {
      try {
        $p = $sl.GetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern)
        $v = [double]$p.Current.Value
        $m = [double]$p.Current.Maximum
        if ($m -gt 0) { $pos = [math]::Round($v, 1); $dur = [math]::Round($m, 1) }
      } catch { }
    }
    $b = Get-PlayerBtn $w.win
    if (-not $b) {
      # controls re-render right after a state change — one short retry
      Start-Sleep -Milliseconds 200
      $b = Get-PlayerBtn $w.win
    }
    if ($b) { $btn = "$($b.Current.Name)" }
  }
  return [ordered]@{
    found    = $true
    selected = [bool]$selected
    hwnd     = [int]$w.hwnd
    title    = "$title"
    url      = $(if ($url) { "$url" } else { $null })
    position = $pos
    duration = $dur
    button   = $btn
    audio    = [bool]$audio
  }
}

# ── ops ─────────────────────────────────────────────────────────────────────
function Op-State($req) {
  $hintT = ''; if ($req.hintTitle) { $hintT = [string]$req.hintTitle }
  $hintV = ''; if ($req.hintVideoId) { $hintV = [string]$req.hintVideoId }
  $wins = Get-ChromeWins
  if (-not $wins -or $wins.Count -eq 0) {
    return [ordered]@{ ok = $true; chrome = $false; track = $null; playing = $null; watch = $null }
  }
  $track = $null; $playing = $null; $watch = $null

  # pass 1 — selected tabs (window name / omnibox)
  foreach ($w in $wins) {
    $url = Read-Omnibox $w
    $raw = [string]$w.win.Current.Name
    $clean = Clean-Title $raw
    $audio = $raw -like '*Audio playing*'
    $isWatch = Test-Watch $url
    $match = $false
    if ($hintV -and $url -and $url.IndexOf($hintV, [StringComparison]::Ordinal) -ge 0) {
      $match = $true
    } elseif ($hintT -and $isWatch -and (Title-Match $clean $hintT)) {
      $match = $true
    }
    if ($match -and -not $track) {
      $track = New-Track $w $url $clean $audio $true
      # the tracked tab may also be the watching/playing one — one read only
      if ($isWatch) {
        $watch = $track
        if ($audio) { $playing = $track }
      }
      continue
    }
    # any selected watch tab: needed as a post-restart fallback ($watch) and
    # for the playing signal ($playing) — one New-Track read serves both
    if ($isWatch -and ((-not $watch) -or ($audio -and -not $playing))) {
      $t = New-Track $w $url $clean $audio $true
      if (-not $watch) { $watch = $t }
      if ($audio -and -not $playing) { $playing = $t }
    }
  }

  # pass 2 — strip scan: tracked tab exists but is NOT selected anywhere
  if (-not $track -and $hintT) {
    foreach ($w in $wins) {
      $strip = Get-Strip $w.win
      if (-not $strip) { continue }
      $hit = $null
      foreach ($ti in (Get-TabItems $strip)) {
        if (Title-Match (Clean-Title ([string]$ti.Current.Name)) $hintT) { $hit = $ti }
      }
      if ($hit) {
        $audio = "$($hit.Current.Name)" -like '*Audio playing*'
        $track = New-Track $w $null (Clean-Title ([string]$hit.Current.Name)) $audio $false
        break
      }
    }
  }

  return [ordered]@{ ok = $true; chrome = $true; track = $track; playing = $playing; watch = $watch }
}

# ── YouTube tab reuse ───────────────────────────────────────────────────────
# A selected-tab URL on any YouTube host (homepage/search/watch all qualify —
# they can all be navigated to a video).
function Test-YoutubeUrl([string]$u) {
  if (-not $u) { return $false }
  $n = Norm-Url $u
  return ($n -match '^(m\.|music\.)?youtube\.com([/?#]|$)') -or ($n -match '^youtu\.be([/?#]|$)')
}

# Strip-only YouTube detection for UNSELECTED tabs (no URL available): the
# tab title is exactly "YouTube"/"YouTube Music" or ends with " - YouTube".
function Test-YoutubeTitle([string]$raw) {
  if (-not $raw) { return $false }
  $s = "$raw"
  $s = $s -replace ' - Memory usage - \d+(\.\d+)? (KB|MB|GB)$', ''
  $s = $s -replace ' - Audio playing$', ''
  $s = $s -replace ' - Google Chrome$', ''
  $s = $s.Trim()
  return ($s -ieq 'YouTube') -or ($s -ieq 'YouTube Music') -or
         ($s -imatch '\s-\sYouTube$') -or ($s -imatch '\s-\sYouTube Music$')
}

# Find an existing YouTube tab to reuse — NEVER launches Chrome, never opens
# a tab. Priority: a window already showing YouTube (selected tab URL wins,
# fg-first), else the rightmost YouTube tab in the strips (fg-first; it gets
# selected so the caller can navigate it).
function Op-FindYoutube($req) {
  $wins = Get-ChromeWins
  if (-not $wins -or $wins.Count -eq 0) {
    return [ordered]@{ ok = $true; found = $false }
  }
  foreach ($w in $wins) {
    $url = Read-Omnibox $w
    if (Test-YoutubeUrl $url) {
      $ttl = Clean-Title ([string]$w.win.Current.Name)
      return [ordered]@{ ok = $true; found = $true; hwnd = [int]$w.hwnd
                         title = "$ttl"; url = "$url"; selected = $true }
    }
  }
  foreach ($w in $wins) {
    $strip = Get-Strip $w.win
    if (-not $strip) { continue }
    $hit = $null
    foreach ($ti in (Get-TabItems $strip)) {   # rightmost match wins
      if (Test-YoutubeTitle ([string]$ti.Current.Name)) { $hit = $ti }
    }
    if ($hit) {
      try {
        $p = $hit.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        $p.Select()
        Start-Sleep -Milliseconds 350
      } catch { return [ordered]@{ ok = $false; code = 'selectfail' } }
      $ttl = Clean-Title ([string]$hit.Current.Name)
      $url = Read-Omnibox $w   # now selected — omnibox readable (may be loading)
      if (-not $url) { $url = '' }
      return [ordered]@{ ok = $true; found = $true; hwnd = [int]$w.hwnd
                         title = "$ttl"; url = "$url"; selected = $true }
    }
  }
  return [ordered]@{ ok = $true; found = $false }
}

function Op-FindUrl($req) {
  $target = [string]$req.url
  $tnorm = Norm-Url $target
  $captchaSearch = $false; if ($req.captchaSearch) { $captchaSearch = [bool]$req.captchaSearch }
  $wins = Get-ChromeWins
  if (-not $wins) { return [ordered]@{ ok = $true; found = $false; captcha = $false } }

  # CAPTCHA first: a /sorry/ redirect would otherwise false-match the search
  # URL hidden inside its continue= parameter. We only REPORT it, never touch it.
  if ($captchaSearch) {
    foreach ($w in $wins) {
      $v = Read-Omnibox $w
      $ttl = Clean-Title ([string]$w.win.Current.Name)
      if (Test-Captcha "$v" "$ttl") {
        return [ordered]@{ ok = $true; found = $false; captcha = $true; title = $ttl; hwnd = [int]$w.hwnd }
      }
    }
  }

  foreach ($w in $wins) {
    $v = Read-Omnibox $w
    if (-not $v) { continue }
    $vn = Norm-Url $v
    # Chrome may display query spaces as %20, + or a raw space — accept all.
    $variants = @($tnorm, ($tnorm -replace '%20', '+'), ($tnorm -replace '%20', ' '))
    $hit = $false
    foreach ($tv in $variants) {
      if ($tv -and (($vn.IndexOf($tv, [StringComparison]::Ordinal) -ge 0) -or
                    ($v.IndexOf($tv, [StringComparison]::OrdinalIgnoreCase) -ge 0))) { $hit = $true; break }
    }
    if ($hit) {
      $ttl = Clean-Title ([string]$w.win.Current.Name)
      return [ordered]@{ ok = $true; found = $true; captcha = $false; title = $ttl; hwnd = [int]$w.hwnd }
    }
  }
  return [ordered]@{ ok = $true; found = $false; captcha = $false; title = ''; hwnd = $null }
}

# Resolve the window an action targets: explicit hwnd, else the foreground
# Chrome window, else the first Chrome window in z-order.
function Select-TargetWin($wins, $hwnd) {
  if ($hwnd) {
    foreach ($w in $wins) { if ([int]$w.hwnd -eq [int]$hwnd) { return $w } }
  }
  if ($wins -and $wins.Count -gt 0) { return $wins[0] }   # already fg-first
  return $null
}

# Resolve the window/tab a hint refers to: selected match first, then the
# rightmost strip match. Returns @{ w; selected; item } or $null.
function Find-Hint($wins, $hintT, $hintV) {
  foreach ($w in $wins) {
    $url = Read-Omnibox $w
    $raw = [string]$w.win.Current.Name
    $clean = Clean-Title $raw
    if ($hintV -and $url -and $url.IndexOf($hintV, [StringComparison]::Ordinal) -ge 0) {
      return @{ w = $w; selected = $true; item = $null; url = $url; clean = $clean; audio = ($raw -like '*Audio playing*') }
    }
    if ($hintT -and (Test-Watch $url) -and (Title-Match $clean $hintT)) {
      return @{ w = $w; selected = $true; item = $null; url = $url; clean = $clean; audio = ($raw -like '*Audio playing*') }
    }
  }
  if ($hintT) {
    foreach ($w in $wins) {
      $strip = Get-Strip $w.win
      if (-not $strip) { continue }
      $hit = $null
      foreach ($ti in (Get-TabItems $strip)) {
        if (Title-Match (Clean-Title ([string]$ti.Current.Name)) $hintT) { $hit = $ti }
      }
      if ($hit) {
        return @{ w = $w; selected = $false; item = $hit; url = $null;
                  clean = (Clean-Title ([string]$hit.Current.Name));
                  audio = ("$($hit.Current.Name)" -like '*Audio playing*') }
      }
    }
  }
  return $null
}

function Get-Hints($req) {
  $t = ''; if ($req.hintTitle) { $t = [string]$req.hintTitle }
  $v = ''; if ($req.hintVideoId) { $v = [string]$req.hintVideoId }
  return @($t, $v)
}

# Bring a found (possibly background) tab to front so its renderer and the
# player buttons are reachable. Returns the wrapper for the now-selected tab.
function Activate-Hint($hit) {
  if ($hit.selected) { return $hit }
  if ($hit.item) {
    try {
      $p = $hit.item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $p.Select()
      Start-Sleep -Milliseconds 350
    } catch { return $null }
  }
  return $hit
}

function Op-Toolbar($req) {
  $action = [string]$req.action
  $hwnd = $null; if ($req.hwnd) { $hwnd = [int]$req.hwnd }
  $wins = Get-ChromeWins
  $w = Select-TargetWin $wins $hwnd
  if (-not $w) { return [ordered]@{ ok = $false; code = 'nowindow' } }

  switch ($action) {
    'current' {
      $url = Read-Omnibox $w
      $ttl = Clean-Title ([string]$w.win.Current.Name)
      return [ordered]@{ ok = $true; url = "$url"; title = "$ttl" }
    }
    'back' { return Invoke-History $w 'Back' 'forward' }
    'forward' { return Invoke-History $w 'Forward' 'back' }
    'reload' {
      $b = Get-ToolBtn $w 'Reload'
      if (-not $b) { return [ordered]@{ ok = $false; code = 'nobutton' } }
      $before = Read-Omnibox $w
      $inv = 'ok'
      try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
      catch { $inv = 'fail' }
      if ($inv -ne 'ok') { return [ordered]@{ ok = $false; code = 'disabled' } }
      Start-Sleep -Milliseconds 600
      $after = Read-Omnibox $w
      if (-not $after) { $after = $before }
      return [ordered]@{ ok = $true; url = "$after" }
    }
    'close' {
      $strip = Get-Strip $w.win
      if (-not $strip) { return [ordered]@{ ok = $false; code = 'notab' } }
      $items = Get-TabItems $strip
      if ($items.Count -le 1) { return [ordered]@{ ok = $false; code = 'onlytab' } }
      $sel = Get-SelectedTab $items
      if (-not $sel) { return [ordered]@{ ok = $false; code = 'notab' } }
      $cb = Find-CloseBtn $strip $sel
      if (-not $cb) { return [ordered]@{ ok = $false; code = 'nobutton' } }
      try {
        $cb.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      } catch { return [ordered]@{ ok = $false; code = 'invokefail' } }
      return [ordered]@{ ok = $true }
    }
    default { return [ordered]@{ ok = $false; code = 'unknown' } }
  }
}

function Invoke-History($w, [string]$btnName, $dir) {
  $b = Get-ToolBtn $w $btnName
  if (-not $b) { return [ordered]@{ ok = $false; code = 'nobutton' } }
  $before = Read-Omnibox $w
  try { $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  catch { return [ordered]@{ ok = $false; code = 'disabled' } }
  Start-Sleep -Milliseconds 600
  $after = Read-Omnibox $w
  if (-not $after) { $after = $before }
  $moved = $false
  if ("$before" -ne "$after") { $moved = $true }
  return [ordered]@{ ok = $true; moved = $moved; url = "$after" }
}

function Op-Player($req) {
  $hint = Get-Hints $req
  $wins = Get-ChromeWins
  if (-not $wins -or $wins.Count -eq 0) { return [ordered]@{ ok = $false; code = 'nowindow' } }
  $hit = Find-Hint $wins $hint[0] $hint[1]
  if (-not $hit) { return [ordered]@{ ok = $false; code = 'notrack' } }
  $hit = Activate-Hint $hit
  if (-not $hit) { return [ordered]@{ ok = $false; code = 'notrack' } }
  $mode = [string]$req.mode

  if ($mode -eq 'key') {
    # keys must land in THIS window — restore/foreground/verify first
    if (-not (Focus-Win ([int]$hit.w.hwnd))) {
      return [ordered]@{ ok = $false; code = 'nofocus' }
    }
    Start-Sleep -Milliseconds 250
    # keyboard focus the page (never the omnibox) before sending player keys
    $dc = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Document)
    $doc = $hit.w.win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $dc)
    if ($doc) { try { $doc.SetFocus() } catch { } }
    Start-Sleep -Milliseconds 150
    $key = 'k'; if ($req.key) { $key = [string]$req.key }
    [System.Windows.Forms.SendKeys]::SendWait($key)
    return [ordered]@{ ok = $true }
  }

  # mode: invoke — exact player button only. `expect` is a regex the button
  # NAME must match before invoking (direction check): e.g. pause sends
  # '^Pause' so a state that flipped in the race can never press Play.
  $btn = Get-PlayerBtn $hit.w.win
  if (-not $btn) { return [ordered]@{ ok = $false; code = 'nobutton' } }
  $name = "$($btn.Current.Name)"
  if ($req.expect) {
    if ($name -notmatch ([string]$req.expect)) {
      return [ordered]@{ ok = $false; code = 'wrongdirection'; button = $name }
    }
  }
  try { $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
  catch { return [ordered]@{ ok = $false; code = 'invokefail' } }
  return [ordered]@{ ok = $true; button = $name }
}

function Op-NavOmnibox($req) {
  $url = [string]$req.url
  if ($url -notmatch '^https?://') { return [ordered]@{ ok = $false; code = 'badurl' } }
  $wins = Get-ChromeWins
  if (-not $wins -or $wins.Count -eq 0) { return [ordered]@{ ok = $false; code = 'nowindow' } }
  $hit = $null
  $hwnd = $null; if ($req.hwnd) { $hwnd = [int]$req.hwnd }
  if ($hwnd) {
    # caller already resolved (and selected) the tab — navigate that window's
    # currently selected tab directly, no hints involved
    foreach ($w in $wins) {
      if ([int]$w.hwnd -eq $hwnd) { $hit = @{ w = $w; selected = $true; item = $null }; break }
    }
    if (-not $hit) { return [ordered]@{ ok = $false; code = 'nowindow' } }
  } else {
    $hint = Get-Hints $req
    $hit = Find-Hint $wins $hint[0] $hint[1]
    if (-not $hit) { return [ordered]@{ ok = $false; code = 'notrack' } }
    $hit = Activate-Hint $hit
    if (-not $hit) { return [ordered]@{ ok = $false; code = 'notrack' } }
  }

  # Chrome may normalize the committed URL (drops/reorders &t= etc.), so a
  # videoId in the target is the thing we verify. A HOST-ONLY target needs an
  # EXACT match — 'youtube.com' must never false-pass 'youtube.com/watch?...'
  # (that only proves the text sits in the omnibox, not that it committed).
  $vidM = [regex]::Match($url, '[?&]v=([\w-]{11})')
  $tnorm = Norm-Url $url
  $hostOnly = ($tnorm -notmatch '/')
  $okAfter = {
    param($a)
    if (-not $a) { return $false }
    $an = Norm-Url $a
    if ($hostOnly) { return ($an -eq $tnorm) }
    if ($vidM.Success) { return $an.IndexOf($vidM.Groups[1].Value, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
    return $an.IndexOf($tnorm, [StringComparison]::Ordinal) -ge 0
  }

  # Keys only work when the target is REALLY foreground (SendKeys would
  # otherwise land in whatever window is visible), and the Enter must go to
  # the omnibox: ^l first (focus + select), THEN rewrite, THEN commit.
  # Two attempts; an honest failure instead of a silent no-op.
  $done = $false
  for ($i = 0; $i -lt 2 -and -not $done; $i++) {
    if (-not (Focus-Win ([int]$hit.w.hwnd))) {
      return [ordered]@{ ok = $false; code = 'nofocus' }
    }
    [System.Windows.Forms.SendKeys]::SendWait('^l')
    Start-Sleep -Milliseconds 150
    # ^l recreates the omnibox element — find it FRESH before writing; the
    # reference captured at op start would throw ElementNotAvailable (a
    # false 'noolbox').
    $wrote = $false
    $om = Get-Omni $hit.w.win
    if ($om) {
      try {
        $vp = $om.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $vp.SetValue($url)
        $wrote = $true
      } catch { $wrote = $false }
    }
    if (-not $wrote) { return [ordered]@{ ok = $false; code = 'noolbox' } }
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 700
    $after = Read-Omni (Get-Omni $hit.w.win)
    if (& $okAfter $after) { $done = $true }
  }
  if (-not $done) { return [ordered]@{ ok = $false; code = 'navfail' } }
  return [ordered]@{ ok = $true; hwnd = [int]$hit.w.hwnd }
}

function Op-CloseHint($req) {
  $hint = Get-Hints $req
  if (-not $hint[0] -and -not $hint[1]) { return [ordered]@{ ok = $true; closed = $false } }
  $wins = Get-ChromeWins
  if (-not $wins) { return [ordered]@{ ok = $true; closed = $false } }
  $hit = Find-Hint $wins $hint[0] $hint[1]
  if (-not $hit) { return [ordered]@{ ok = $true; closed = $false } }
  $hit = Activate-Hint $hit
  if (-not $hit) { return [ordered]@{ ok = $true; closed = $false } }
  $strip = Get-Strip $hit.w.win
  if (-not $strip) { return [ordered]@{ ok = $true; closed = $false } }
  $items = Get-TabItems $strip
  # closing the last tab would close a whole window — never do that here
  if ($items.Count -le 1) { return [ordered]@{ ok = $true; closed = $false } }
  $target = Get-SelectedTab $items
  if (-not $target -and $hit.item) { $target = $hit.item }
  if (-not $target) { return [ordered]@{ ok = $true; closed = $false } }
  $cb = Find-CloseBtn $strip $target
  if (-not $cb) { return [ordered]@{ ok = $true; closed = $false } }
  $done = $false
  try {
    $cb.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $done = $true
  } catch { $done = $false }
  return [ordered]@{ ok = $true; closed = [bool]$done }
}

function Handle($req) {
  $op = [string]$req.op
  switch ($op) {
    'ping' { return [ordered]@{ ok = $true } }
    'state' { return Op-State $req }
    'findUrl' { return Op-FindUrl $req }
    'findYoutube' { return Op-FindYoutube $req }
    'toolbar' { return Op-Toolbar $req }
    'player' { return Op-Player $req }
    'navOmnibox' { return Op-NavOmnibox $req }
    'closeHint' { return Op-CloseHint $req }
    default { return [ordered]@{ ok = $false; error = "Unknown op: $op." } }
  }
}

# ─── Command loop: one JSON line in, one JSON line out ──────────────────────
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }   # bridge closed stdin -> exit
  if ($line.Trim().Length -eq 0) { continue }

  $id = $null
  $resp = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $resp = Handle $req
  } catch {
    $resp = [ordered]@{ ok = $false; error = $_.Exception.Message }
  }
  $resp['id'] = $id

  [Console]::Out.WriteLine((ConvertTo-Json $resp -Compress -Depth 6))
  [Console]::Out.Flush()
}
