$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed ($LASTEXITCODE): $Executable"
    }
}

# Requires Python 3.11+ and Node supported by terminal-react/package.json.
if (Get-Command py -ErrorAction SilentlyContinue) {
    Invoke-Checked -Executable 'py' -Arguments @('-3', '-m', 'venv', '.venv')
} else {
    Invoke-Checked -Executable 'python' -Arguments @('-m', 'venv', '.venv')
}
$Python = Join-Path $PWD '.venv\Scripts\python.exe'
Invoke-Checked -Executable $Python -Arguments @('-m', 'pip', 'install', '-r', 'requirements.lock.txt')
Invoke-Checked -Executable 'npm.cmd' -Arguments @('ci', '--prefix', 'terminal-react')
Invoke-Checked -Executable 'npm.cmd' -Arguments @('run', 'build', '--prefix', 'terminal-react')
$env:GEX_DEMO_MODE = 'false'
$Port = if ($env:PORT) { $env:PORT } else { '8000' }
# Local only. No change to the Windows execution policy or firewall.
Invoke-Checked -Executable $Python -Arguments @('-m', 'uvicorn', 'app:app', '--app-dir', 'backend', '--host', '127.0.0.1', '--port', $Port)
