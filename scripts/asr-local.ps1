param(
    [string]$Wav = '',
    [string]$Out = '',
    [switch]$Probe
)
# 本机离线语音识别（Windows 自带 System.Speech + 中文桌面识别器）
# 用法：
#   -Probe                      → 只探测有没有可用的识别器
#   -Wav <路径> -Out <结果文件>  → 识别一个 WAV，把结果以 UTF-8 JSON 写进 Out
# 说明：全部在本机完成，不联网、不上传 —— 录音不出这台电脑。
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Result($obj) {
    if ($Out) { [System.IO.File]::WriteAllText($Out, ($obj | ConvertTo-Json -Compress), $utf8) }
    else { $obj | ConvertTo-Json -Compress | Write-Output }
}

try {
    Add-Type -AssemblyName System.Speech
} catch {
    Write-Result @{ ok = $false; error = 'system_speech_unavailable'; message = "$($_.Exception.Message)" }
    exit 0
}

$recs = @()
try {
    $recs = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
} catch {
    Write-Result @{ ok = $false; error = 'enum_failed'; message = "$($_.Exception.Message)" }
    exit 0
}

if ($Probe) {
    $list = @()
    foreach ($r in $recs) { $list += @{ name = $r.Name; culture = $r.Culture.Name } }
    Write-Result @{ ok = ($recs.Count -gt 0); count = $recs.Count; recognizers = $list }
    exit 0
}

if (-not $recs -or $recs.Count -eq 0) {
    Write-Result @{ ok = $false; error = 'no_recognizer'; message = '系统没有安装任何语音识别器' }
    exit 0
}
if (-not $Wav -or -not (Test-Path $Wav)) {
    Write-Result @{ ok = $false; error = 'wav_not_found'; message = "找不到 WAV：$Wav" }
    exit 0
}

try {
    # 优先选中文识别器
    $pick = $recs | Where-Object { $_.Culture.Name -like 'zh*' } | Select-Object -First 1
    if (-not $pick) { $pick = $recs[0] }

    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($pick)
    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $engine.SetInputToWaveFile($Wav)
    $engine.BabbleTimeout = [TimeSpan]::FromSeconds(2)
    $engine.EndSilenceTimeout = [TimeSpan]::FromSeconds(1)
    $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(3)

    $res = $engine.Recognize([TimeSpan]::FromSeconds(20))
    $engine.Dispose()

    if ($res) {
        Write-Result @{ ok = $true; text = $res.Text; confidence = [math]::Round($res.Confidence, 3); recognizer = $pick.Name; culture = $pick.Culture.Name }
    } else {
        Write-Result @{ ok = $true; text = ''; reason = 'no_speech'; recognizer = $pick.Name; culture = $pick.Culture.Name }
    }
} catch {
    Write-Result @{ ok = $false; error = 'recognize_failed'; message = "$($_.Exception.Message)" }
}
