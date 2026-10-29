# LM Studio inference speed benchmark (ASCII-only on purpose).
# NOTE: This file must stay ASCII. Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI,
#       so any non-ASCII character here would break parsing. Pass non-ASCII text via -Prompt.
#
# Usage:
#   .\bench-lmstudio.ps1 -Label "mtp_on" -Prompt "<your prompt>" -OutFile results.jsonl

param(
    [string]$Label     = 'run',
    [string]$ModelKey  = 'qwen/qwen3.8-27b',
    [int]   $MaxTokens = 400,
    [string]$Prompt    = 'List three kinds of quantitative data that an effect-evaluation section in a post-evaluation report should contain, with one example each.',
    [string]$OutFile   = ''
)

$ErrorActionPreference = 'Stop'

$payload = @{
    model       = $ModelKey
    messages    = @(
        @{ role = 'system'; content = 'You are a petroleum engineering audit assistant. Answer concisely, in bullet points.' },
        @{ role = 'user';   content = $Prompt }
    )
    max_tokens  = $MaxTokens
    temperature = 0.2
    stream      = $false
} | ConvertTo-Json -Depth 6

# Must convert to UTF-8 bytes explicitly, otherwise non-ASCII text is lost.
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)

$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:1234/v1/chat/completions' `
                           -Method Post -Body $bytes `
                           -ContentType 'application/json; charset=utf-8' `
                           -TimeoutSec 900
    $sw.Stop()
    $sec  = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    $ct   = [int]$r.usage.completion_tokens
    $tps  = [math]::Round($ct / $sw.Elapsed.TotalSeconds, 3)
    $res = [pscustomobject]@{
        Label         = $Label
        Seconds       = $sec
        PromptTokens  = [int]$r.usage.prompt_tokens
        GenTokens     = $ct
        TokPerSec     = $tps
        FinishReason  = $r.choices[0].finish_reason
        HasReasoning  = [bool]$r.choices[0].message.reasoning_content
        AnswerChars   = if ($r.choices[0].message.content) { $r.choices[0].message.content.Length } else { 0 }
    }
}
catch {
    $sw.Stop()
    $res = [pscustomobject]@{
        Label = $Label; Seconds = [math]::Round($sw.Elapsed.TotalSeconds,2)
        PromptTokens = 0; GenTokens = 0; TokPerSec = 0
        FinishReason = ('ERROR: ' + $_.Exception.Message); HasReasoning = $false; AnswerChars = 0
    }
}

$res | Format-List
if ($OutFile) { $res | ConvertTo-Json -Compress | Add-Content -Path $OutFile -Encoding UTF8 }
