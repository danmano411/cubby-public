# Offline voice commands via Windows' built-in recognizer. Nothing leaves the machine.
# stdout, one line per utterance: "<grammar>|<text>|<confidence>"  (grammar = cmd or dictation)
# -phrases "a|b c|d" is the full phrase list (wake word alone, wake + command, bare commands); Cubby decides.
# -wav <file> reads from a WAV instead of the microphone (used for testing).
param([string]$phrases, [string]$wav)
Add-Type -AssemblyName System.Speech
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine (New-Object System.Globalization.CultureInfo 'en-US')
$choices = New-Object System.Speech.Recognition.Choices
$choices.Add([string[]]($phrases -split '\|' | Where-Object { $_ }))
$cmd = New-Object System.Speech.Recognition.Grammar (New-Object System.Speech.Recognition.GrammarBuilder $choices)
$cmd.Name = 'cmd'
$r.LoadGrammar($cmd)
# No dictation grammar: on real mics it out-competed the wake word and produced gibberish. With only the
# command grammar, non-matching speech is rejected or comes back with low confidence (Cubby filters).
if ($wav) { $r.SetInputToWaveFile($wav) } else { $r.SetInputToDefaultAudioDevice() }
# Any recognizer error (end of WAV, mic unplugged) ends the script; Cubby restarts it after a pause.
try {
  while ($true) {
    $res = $r.Recognize()
    if ($res) { [Console]::WriteLine("$($res.Grammar.Name)|$($res.Text)|$($res.Confidence)") }
    elseif ($wav) { break }
  }
} catch { exit 1 }
