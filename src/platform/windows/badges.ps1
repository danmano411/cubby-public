# Reads taskbar badges (the red "2" / "9+" overlays) via UI Automation: Windows has no API for
# them, but each taskbar button's HelpText carries the badge description, e.g. Discord
# "Unread messages", Teams "9+ items, status Unknown" / "No items, status Available".
# stdout: one JSON object { "<taskbar AppID>": "<HelpText>" } whenever it changes. ~40ms per scan.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$isButton = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'Taskbar.TaskListButtonAutomationPeer')
$isTaskbar = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'Shell_TrayWnd')
$last = $null
while ($true) {
  try {
    $out = @{}
    $tray = $A::RootElement.FindFirst('Children', $isTaskbar)
    foreach ($b in $tray.FindAll('Descendants', $isButton)) {
      $help = $b.Current.HelpText
      # Pinned buttons of closed apps keep a stale description (e.g. Teams "9+ items" long after
      # it quit), so only running apps count: their Name says "... - 1 running window".
      if ($help -and $b.Current.Name -match 'running window') { $out[$b.Current.AutomationId -replace '^Appid: ', ''] = $help }
    }
    $json = $out | ConvertTo-Json -Compress
    if ($json -ne $last) { [Console]::WriteLine($json); $last = $json }
  } catch { }
  Start-Sleep -Seconds 2
}
