# Keep the machine awake for the lifetime of this process (pipeline runs).
# Uses SetThreadExecutionState — does NOT send keystrokes (non-disruptive, reliable),
# unlike the SendKeys SCROLLLOCK approach. Caller kills this when the run completes.
$sig = @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$ka = Add-Type -MemberDefinition $sig -Name 'KeepAwake' -Namespace 'Win32Native' -PassThru
# ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1) | ES_DISPLAY_REQUIRED (0x2)
while ($true) {
    [void]$ka::SetThreadExecutionState([uint32]'0x80000003')
    Start-Sleep -Seconds 50
}
