<#
.SYNOPSIS
  Stops any KeyPool server started from this checkout.

.DESCRIPTION
  Called by run.bat before it builds, so that the process serving requests is
  always the one built from the sources currently on disk.

  A server loads its code once, at boot. Editing the proxy and restarting is
  therefore a no-op unless the previous process is actually stopped - and
  "the port was still in use" is the usual reason nothing happens. That is the
  failure this script exists to remove.

  Identification is by the script the process is running, not by the port it
  happens to hold. The port is only a fallback, because the number a KeyPool
  binds is overridable from the database (resolveBootSettings in
  server/src/settings.ts): an instance left over from a run with a different
  PORT, or with the port changed in the dashboard, holds a number this script
  was not told about. Matching on the resolved server path finds those, and
  only those.

  Both ways of serving from this checkout are matched: the built server, and the
  dev server behind `pnpm dev`. The dev one needs care - `tsx watch` is a
  supervisor that spawns the process which actually holds the port, so the child
  is stopped too, or the port stays bound by an orphan.

  Nothing outside this checkout is touched. The matcher requires an absolute
  path belonging to *this* checkout, which is the only evidence available:
  Win32_Process exposes no working directory, so a relative `src/index.ts`
  cannot be attributed to a project and is never matched on its own. Every stop
  is reported with its PID and port, so nothing happens silently.

.PARAMETER Root
  The repository root. Defaults to KP_ROOT from the environment, which run.bat
  sets, and falls back to this script's parent directory.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stop-keypool.ps1
#>
[CmdletBinding()]
param(
  [string] $Root = $env:KP_ROOT
)

$ErrorActionPreference = 'Stop'

if (-not $Root -or -not (Test-Path -LiteralPath $Root)) {
  $Root = Split-Path -Parent $PSScriptRoot
}
$Root = [System.IO.Path]::GetFullPath($Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar)

# The absolute paths a KeyPool from this checkout runs. Compared with Ordinal
# IgnoreCase so a drive-letter or casing difference cannot hide a match.
$serverScript = [System.IO.Path]::GetFullPath((Join-Path $Root 'server\dist\index.js'))

# The dev launcher, identified by the one string on its command line that is
# unique to this checkout: the path of the tsx binary it invokes.
#
# `pnpm dev` cannot be matched on the argument it passes. The command line is
# `tsx watch src/index.ts` - a *relative* path - and Win32_Process exposes no
# working directory, so there is nothing on the command line that says which
# checkout that `src` belongs to. Measured on this machine, an unrelated
# project's `npx tsx watch src/index.ts` looks identical except for the missing
# checkout path, so matching the argument would kill a stranger's server - the
# same failure the absolute-path rule below exists to prevent.
#
# Three shapes of that path are in circulation, and all three have to match or a
# dev server survives the stop step and keeps the port:
#
#   1. via the bin shim   server\node_modules\.bin\..\tsx\dist\cli.mjs   (pnpm dev)
#   2. via the symlink    server\node_modules\tsx\dist\cli.mjs
#   3. via the pnpm store node_modules\.pnpm\tsx@<ver>\node_modules\tsx\dist\cli.mjs
#
# Shape 3 carries a version in the directory name, so it cannot be spelled as a
# literal path and is matched by its fixed prefix instead. All three live inside
# this checkout, which is what makes the prefix safe: a foreign project's tsx
# resolves inside its own node_modules and never carries this path.
$devLaunchers = @(
  [System.IO.Path]::GetFullPath((Join-Path $Root 'server\node_modules\tsx\dist\cli.mjs')),
  [System.IO.Path]::GetFullPath((Join-Path $Root 'node_modules\tsx\dist\cli.mjs'))
)

# Prefix for the pnpm store copy, whose version segment is not knowable ahead of
# time. Trimmed of its trailing separator so it reads as a directory.
$devStorePrefix = [System.IO.Path]::GetFullPath((Join-Path $Root 'node_modules\.pnpm')).TrimEnd('\') + '\tsx@'

# Ports that are ours to release, used only to tell the operator what was freed.
$portsOf = {
  param([int] $ProcessId)
  try {
    @(Get-NetTCPConnection -OwningProcess $ProcessId -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty LocalPort)
  } catch {
    # No listening sockets, or the cmdlet is unavailable on this host. Either
    # way there is no port worth reporting.
    @()
  }
}

function Test-KeyPoolProcess {
  param([string] $CommandLine)

  if (-not $CommandLine) { return $false }

  # Normalise separators: a command line assembled with forward slashes is the
  # same process, and Node accepts both.
  $normalised = $CommandLine.Replace('/', '\')

  if ($normalised.IndexOf($serverScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
    return $true
  }

  # The dev launcher of this checkout, on the tsx binary path alone.
  #
  # No `src/index.ts` test here, and that omission is the point: that argument
  # is relative, so it is identical in every project that runs `tsx watch
  # src/index.ts`, and matching it was measured killing an unrelated project's
  # server on this machine. The launcher matches on its resolved binary path;
  # the process actually serving the port is found by parent linkage below.
  #
  # The `.bin\..\` hop has to be collapsed before the comparison can work. pnpm
  # invokes the launcher through the bin shim, so the path on the command line
  # is `server\node_modules\.bin\\..\tsx\dist\cli.mjs` - the *resolved* path
  # never appears, and it is written with a doubled separator besides. Compared
  # literally it misses; compared with the separators merely folded it still
  # misses, because `.bin..` sits in the middle of the string rather than at an
  # end. Removing the hop is what makes both forms comparable, and it is a
  # pure path normalisation: `a\.bin\..\b` and `a\b` are the same file.
  $canonical = [regex]::Replace($normalised, '\.bin\\+\.\.\\+', '', 'IgnoreCase')
  foreach ($launcher in $devLaunchers) {
    if ($canonical.IndexOf($launcher, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  }

  # The pnpm store copy, whose `tsx@<version>` segment cannot be spelled out in
  # advance. Matched on the fixed `...\node_modules\.pnpm\tsx@` prefix and then
  # only when the remainder is this checkout's own launcher tail - the prefix on
  # its own is already inside this checkout, but requiring the tail as well means
  # a command line that merely walks through .pnpm on its way somewhere else
  # cannot match by accident.
  $storeIndex = $canonical.IndexOf($devStorePrefix, [System.StringComparison]::OrdinalIgnoreCase)
  if ($storeIndex -ge 0) {
    $afterStore = $canonical.Substring($storeIndex + $devStorePrefix.Length)
    if ($afterStore.IndexOf('\node_modules\tsx\dist\cli.mjs', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      return $true
    }
  }

  # Absolute path only, and that restriction is deliberate.
  #
  # The obvious extension is to also match the bare "server\dist\index.js" an
  # older launcher left on the command line - but that string is identical in
  # every Node project on the machine, and there is no way to tell them apart
  # from a script: Win32_Process exposes no working directory, so the argument
  # cannot be resolved against the checkout that owns it. Matching it was
  # measured killing an unrelated project's server on this machine.
  #
  # So the relative form is refused outright, and run.bat launches the server by
  # absolute path so every instance it creates stays identifiable. A process
  # left by an older launcher is not terminated blind: missing it costs a clear
  # "address already in use", while matching it would cost a stranger's program.
  return $false
}

# Enumerating is separated from filtering so a failed lookup cannot be reported
# as "nothing was running". Those two are opposite claims: the first means the
# caller may start, the second means the enumeration itself did not work. Under
# -ErrorAction SilentlyContinue the second would print the first, and the
# launcher would build and start on the strength of a query that never ran.
try {
  $nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)
} catch {
  Write-Output "  [X] could not enumerate node processes: $($_.Exception.Message)"
  exit 2
}

$targets = @(
  $nodeProcesses |
    Where-Object { Test-KeyPoolProcess $_.CommandLine } |
    Select-Object ProcessId, CommandLine
)

# The dev launcher is not the process serving requests.
#
# `tsx watch` is a supervisor: it holds a node process for the watcher and
# spawns the actual server as a child, which is the one bound to the port.
# Stopping only the launcher orphans that child, and the restart then fails to
# bind - the exact failure this script exists to remove, arriving through a new
# door. Measured here: the watcher was PID 6216 and the child holding the port
# was PID 34700.
#
# So descendants of a matched process are matched too, walked transitively. The
# walk is by parent linkage and is bounded, so it cannot wander into a process
# tree that merely happens to sit below a matching PID.
if ($targets.Count -gt 0) {
  $matched = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($t in $targets) { [void] $matched.Add([int] $t.ProcessId) }

  # Repeating until no new PID appears handles grandchildren, since a single
  # pass over a fixed list can miss a child discovered after its parent matched.
  $grew = $true
  while ($grew) {
    $grew = $false
    foreach ($proc in $nodeProcesses) {
      $pid_ = [int] $proc.ProcessId
      $parent = [int] $proc.ParentProcessId
      if ($matched.Contains($pid_)) { continue }
      if ($matched.Contains($parent)) {
        [void] $matched.Add($pid_)
        $grew = $true
        $targets = @($targets) + , ([pscustomobject]@{ ProcessId = $pid_; CommandLine = $proc.CommandLine })
        Write-Output "    also stopping PID $pid_ (child of a dev server in this checkout)"
      }
    }
  }
}

# A KeyPool can also be started another way - `pnpm dev` runs tsx against
# server/src/index.ts, and a person may well type `node server/src/index.js`.
# Those carry no path this script is willing to match, so they are not stopped.
# They are reported instead, because the alternative is the failure this whole
# change exists to prevent: a dev server left holding the port, quietly serving
# code from before the edit, while the launcher reports a clean start.
#
# The `-not` guard is load-bearing rather than cosmetic. The pattern below also
# matches this checkout's own absolute path, so without it every instance that
# was just stopped correctly would be reported a second time as unidentifiable -
# claiming it was left running when it was not. Anything already in $targets is
# excluded first.
$unidentified = @(
  $nodeProcesses |
    Where-Object {
      $_.CommandLine -and
      $_.ProcessId -notin $targets.ProcessId -and
      $_.CommandLine -match '(@keypool/server|tsx.*server[\\/]src[\\/]index\.ts)' -and
      -not (Test-KeyPoolProcess $_.CommandLine)
    } |
    Select-Object -ExpandProperty ProcessId
)

if ($targets.Count -eq 0) {
  if ($unidentified.Count -gt 0) {
    Write-Output '    nothing identifiable was running'
    Write-Output "    NOTE: PID $($unidentified -join ', ') looks like a KeyPool started another way (dev mode or by hand)."
    Write-Output '      It was left running, so it could not be identified with certainty.'
    Write-Output '      If it is holding the port the start below will fail; otherwise ignore this.'
  } else {
    Write-Output '    nothing was running'
  }
  exit 0
}

$failed = @()

foreach ($target in $targets) {
  $pid_ = [int] $target.ProcessId
  if ($pid_ -eq $PID) { continue }

  $ports = & $portsOf $pid_
  $portText = if ($ports.Count -gt 0) { $ports -join ',' } else { 'none' }

  try {
    # Terminated outright, deliberately.
    #
    # The obvious improvement is to ask first and force only if it refuses, so
    # the server's own shutdown handler runs and the StatsRecorder gets its
    # final flush. That does not work on Windows, and the measurement is worth
    # recording: `Stop-Process` with and without -Force deliver no signal to a
    # console process at all - a test handler for SIGINT/SIGTERM/SIGBREAK was
    # never invoked and the process simply died. Dropping -Force changes
    # nothing. There is no way to raise a console control event from a script,
    # short of writing to the process's console with native interop.
    #
    # So the cost is bounded and stated instead: at most one flush interval
    # (2s, or 300ms with live-feed subscribers) of request-log rows can be
    # lost, and only for requests that completed in the instant before the
    # restart. Stopping from the console with Ctrl+C, which does run the
    # handler, remains the lossless path.
    Stop-Process -Id $pid_ -Force -ErrorAction Stop
    Write-Output "    stopped PID $pid_ (port $portText)"
  } catch {
    # Already gone between the query and the stop: not an error to report.
    if ($_.Exception.Message -match 'not found|cannot find|No process') {
      Write-Output "    PID $pid_ had already exited"
    } else {
      $failed += $pid_
      Write-Output "    [X] could not stop PID $pid_ : $($_.Exception.Message)"
    }
  }
}

# Confirm the processes are actually gone before the caller builds and rebinds.
# Bounded, because a process that will not die should surface as a bind error
# with a clear message rather than as a hang here.
$deadline = (Get-Date).AddSeconds(10)
do {
  $remaining = @(
    $targets |
      ForEach-Object { [int] $_.ProcessId } |
      Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }
  )
  if ($remaining.Count -eq 0) { break }
  Start-Sleep -Milliseconds 200
} while ((Get-Date) -lt $deadline)

if ($remaining.Count -gt 0) {
  Write-Output "  [X] WARNING: PID $($remaining -join ', ') did not exit"
  exit 1
}

if ($failed.Count -gt 0) {
  Write-Output "  [X] WARNING: PID $($failed -join ', ') could not be stopped"
  exit 1
}

Write-Output '    all stopped'
exit 0
