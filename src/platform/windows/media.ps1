# System media sessions (Spotify, browsers, Media Player, ...) via the Windows 10+ transport controls API.
# stdout: one JSON line whenever the focused session changes:
#   {"playing":true,"app":"Spotify.exe","title":"Song","artist":"Artist"}  ({"playing":false} when no session)
# stdin: one command per line (play = toggle play/pause, next, prev), sent to the session that is playing,
# else the system's current one. Exits when stdin closes, so it never outlives Cubby.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$Mgr = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$Props = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]

# WinRT async -> blocking result: AsTask is a generic extension method, so find the IAsyncOperation overload by hand.
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$task.Wait(5000)
  $task.Result
}

$mgr = Await ($Mgr::RequestAsync()) $Mgr

# The session that is playing (the current one if several are), else the system's current session.
function Pick {
  $cur = $mgr.GetCurrentSession()
  $isPlaying = { param($s) $s -and $s.GetPlaybackInfo().PlaybackStatus -eq 'Playing' }
  if (& $isPlaying $cur) { return $cur }
  $playing = @($mgr.GetSessions()) | Where-Object { & $isPlaying $_ } | Select-Object -First 1
  if ($playing) { return $playing }
  $cur
}

function Run($cmd) {
  $s = Pick
  if (-not $s) { return }
  switch ($cmd) {
    'play' { [void](Await ($s.TryTogglePlayPauseAsync()) ([bool])) }
    'next' { [void](Await ($s.TrySkipNextAsync()) ([bool])) }
    'prev' { [void](Await ($s.TrySkipPreviousAsync()) ([bool])) }
  }
}

# Console.In.ReadLineAsync blocks until a line arrives, so read raw stdin bytes with a pending task instead.
$stdin = [Console]::OpenStandardInput()
$buf = New-Object byte[] 256
$pending = ''
$read = $stdin.ReadAsync($buf, 0, $buf.Length)
$last = $null
while ($true) {
  try {
    while ($read.IsCompleted) {
      $n = $read.Result
      if ($n -eq 0) { exit 0 }
      $pending += [System.Text.Encoding]::UTF8.GetString($buf, 0, $n)
      $read = $stdin.ReadAsync($buf, 0, $buf.Length)
      while (($i = $pending.IndexOf("`n")) -ge 0) {
        $cmd = $pending.Substring(0, $i).Trim().ToLower()
        $pending = $pending.Substring($i + 1)
        Run $cmd
      }
    }
    $s = Pick
    if ($s) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) $Props
      $state = [ordered]@{ playing = ($s.GetPlaybackInfo().PlaybackStatus -eq 'Playing'); app = $s.SourceAppUserModelId; title = $p.Title; artist = $p.Artist }
    } else {
      $state = [ordered]@{ playing = $false }
    }
    $json = $state | ConvertTo-Json -Compress
    if ($json -ne $last) { [Console]::Out.WriteLine($json); [Console]::Out.Flush(); $last = $json }
  } catch { }
  Start-Sleep -Milliseconds 500
}
