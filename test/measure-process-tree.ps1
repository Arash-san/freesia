param([Parameter(Mandatory=$true)][int]$RootProcess,[int]$Seconds=20)
$ErrorActionPreference='Stop'
$logical=[Environment]::ProcessorCount
$seen=@{}
$previous=@{}
$samples=[Collections.Generic.List[object]]::new()
$watch=[Diagnostics.Stopwatch]::StartNew()
$lastTime=0.0
while($watch.Elapsed.TotalSeconds -le $Seconds+1){
 $now=$watch.Elapsed.TotalSeconds
 $all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)
 $ids=[Collections.Generic.HashSet[int]]::new()
 [void]$ids.Add($RootProcess)
 $changed=$true
 while($changed){$changed=$false;foreach($proc in $all){if($ids.Contains([int]$proc.ParentProcessId)-and !$ids.Contains([int]$proc.ProcessId)){[void]$ids.Add([int]$proc.ProcessId);$changed=$true}}}
 foreach($known in @($seen.Keys)){if($all.ProcessId -contains $known){[void]$ids.Add([int]$known)}}
 $rows=@();$working=0L;$private=0L;$delta=0.0
 foreach($procId in $ids){$proc=Get-Process -Id $procId -ErrorAction SilentlyContinue;if(!$proc){continue}
  $cpu=$proc.TotalProcessorTime.TotalSeconds
  $seen[$procId]=$true
  if($previous.ContainsKey($procId)){$delta += [Math]::Max(0.0,$cpu-$previous[$procId])}
  $previous[$procId]=$cpu
  $working+=$proc.WorkingSet64;$private+=$proc.PrivateMemorySize64
  $rows+=@{pid=$procId;name=$proc.ProcessName;workingMiB=$proc.WorkingSet64/1MB;privateMiB=$proc.PrivateMemorySize64/1MB;cpuSeconds=$cpu}
 }
 if($samples.Count -gt 0){$samples.Add(@{elapsedSec=$now;workingMiB=$working/1MB;privateMiB=$private/1MB;cpuPercent=100*$delta/[Math]::Max(.001,$now-$lastTime)/$logical;cores=$delta/[Math]::Max(.001,$now-$lastTime);processes=$rows})}
 else{$samples.Add(@{elapsedSec=$now;workingMiB=$working/1MB;privateMiB=$private/1MB;cpuPercent=0;cores=0;processes=$rows})}
 $lastTime=$now
 $wait=[Math]::Max(0,1000-($watch.Elapsed.TotalSeconds-$now)*1000)
 if($watch.Elapsed.TotalSeconds -ge $Seconds){break}
 Start-Sleep -Milliseconds ([int]$wait)
}
$cpuSamples=@($samples | Select-Object -Skip 1)
$result=@{logicalProcessors=$logical;durationSec=$watch.Elapsed.TotalSeconds;samples=$samples.ToArray();meanWorkingMiB=($cpuSamples.workingMiB|Measure-Object -Average).Average;peakWorkingMiB=($samples.workingMiB|Measure-Object -Maximum).Maximum;meanPrivateMiB=($cpuSamples.privateMiB|Measure-Object -Average).Average;meanCpuPercent=($cpuSamples.cpuPercent|Measure-Object -Average).Average;meanCores=($cpuSamples.cores|Measure-Object -Average).Average}
ConvertTo-Json -InputObject $result -Depth 8 -Compress
