# Reads taskbar badges (the red "2" / "9+" overlays) via UI Automation: Windows has no API for
# them, but each taskbar button's HelpText carries the badge description, e.g. Discord
# "Unread messages", Teams "9+ items, status Unknown" / "No items, status Available".
# stdout: one JSON object { "<taskbar AppID>": "<HelpText>" } whenever it changes.
# -Once: print one scan (always) and exit; used by scripts/diag/badge-regress.ps1.
param([switch]$Once)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class Taskbars {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder b, int n);
  static string Cls(IntPtr h) { var b = new StringBuilder(256); GetClassNameW(h, b, 256); return b.ToString(); }
  // The window holding the app buttons on every taskbar (main + one per extra monitor).
  public static List<IntPtr> ButtonHosts() {
    var hosts = new List<IntPtr>();
    EnumWindows((t, _) => {
      var c = Cls(t);
      if (c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd")
        EnumChildWindows(t, (k, __) => { if (Cls(k) == "Windows.UI.Composition.DesktopWindowContentBridge") hosts.Add(k); return true; }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return hosts;
  }
}
'@
$A = [System.Windows.Automation.AutomationElement]
$isButton = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'Taskbar.TaskListButtonAutomationPeer')
$isTaskbar = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'Shell_TrayWnd')

# An auto-hidden taskbar hides the window holding its buttons, and tree walks skip hidden windows,
# so walking from the root sees no buttons until the taskbar slides up. Asking that window directly
# by handle answers while it's hidden. The root walk stays as the fallback for taskbars without it.
function Buttons {
  $found = @()
  foreach ($h in [Taskbars]::ButtonHosts()) {
    try { $found += @($A::FromHandle($h).FindAll('Descendants', $isButton)) } catch { }
  }
  if (-not $found.Count) {
    $tray = $A::RootElement.FindFirst('Children', $isTaskbar)
    if ($tray) { $found = @($tray.FindAll('Descendants', $isButton)) }
  }
  $found
}

$last = $null
while ($true) {
  try {
    $buttons = Buttons
    # No buttons at all means the taskbar can't be read right now, not "no badges": keep the last answer.
    if ($buttons.Count -or $Once) {
      $out = @{}
      foreach ($b in $buttons) {
        $help = $b.Current.HelpText
        # Pinned buttons of closed apps keep a stale description (e.g. Teams "9+ items" long after
        # it quit), so only running apps count: their Name says "... - 1 running window".
        # An app on two taskbars reports the same text twice; the AppID key keeps one.
        if ($help -and $b.Current.Name -match 'running window') { $out[$b.Current.AutomationId -replace '^Appid: ', ''] = $help }
      }
      $json = $out | ConvertTo-Json -Compress
      if ($json -ne $last -or $Once) { [Console]::WriteLine($json); $last = $json }
    }
  } catch { }
  if ($Once) { break }
  Start-Sleep -Seconds 2
}
