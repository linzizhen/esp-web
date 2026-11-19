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

    # 循环识别：Recognize() 一次只返回「一句话」。原来只调一次，长录音后面的话
    # 全部丢掉（用户实测 8~10 秒的录音只换回一个「嗯」）。这里一直收到 $null 为止。
    $parts = @()
    $conf = @()
    $firstErr = ''
    $deadline = (Get-Date).AddSeconds(40)
    while ((Get-Date) -lt $deadline) {
        $res = $null
        try {
            $res = $engine.Recognize([TimeSpan]::FromSeconds(10))
        } catch {
            # 音频流读完之后再调 Recognize 会抛「没有将任何音频输入提供给此识别器」，
            # 这是正常的结束信号，不是故障；但若一条都没识别出来就记下原因。
            if ($parts.Count -eq 0) { $firstErr = "$($_.Exception.Message)" }
            break
        }
        if (-not $res) { break }
        if ($res.Text) { $parts += $res.Text; $conf += $res.Confidence }
    }
    $engine.Dispose()

    if ($parts.Count -gt 0) {
        $text = ($parts -join '')
        $avg = 0.0
        if ($conf.Count -gt 0) { $avg = ($conf | Measure-Object -Average).Average }
        Write-Result @{ ok = $true; text = $text; parts = $parts.Count; confidence = [math]::Round($avg, 3); recognizer = $pick.Name; culture = $pick.Culture.Name }
    } else {
        Write-Result @{ ok = $true; text = ''; reason = 'no_speech'; first_error = $firstErr; recognizer = $pick.Name; culture = $pick.Culture.Name }
    }
} catch {
    Write-Result @{ ok = $false; error = 'recognize_failed'; message = "$($_.Exception.Message)" }
}
