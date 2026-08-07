param(
  [string]$ProcessName = "",
  [int]$ClickX = -1,
  [int]$ClickY = -1,
  [string]$Text = "",
  [switch]$PressEnter,
  [string]$OutPath = "C:\Users\Public\marvin_input_after.png"
)
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Input {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, int dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
}
"@
if ($ProcessName -ne "") {
  $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
  if ($proc) {
    [Win32Input]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
    [Win32Input]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 800
  }
}
if ($ClickX -ge 0 -and $ClickY -ge 0) {
  [Win32Input]::SetCursorPos($ClickX, $ClickY) | Out-Null
  Start-Sleep -Milliseconds 150
  [Win32Input]::mouse_event(0x0002, 0, 0, 0, 0)  # left down
  [Win32Input]::mouse_event(0x0004, 0, 0, 0, 0)  # left up
  Start-Sleep -Milliseconds 300
}
if ($Text -ne "") {
  # Clipboard+paste, not SendKeys character-by-character -- robust against
  # accented/Unicode text (Hungarian), which SendKeys mangles.
  Set-Clipboard -Value $Text
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Start-Sleep -Milliseconds 400
}
if ($PressEnter) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  Start-Sleep -Milliseconds 500
}
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
"done" | Out-File -FilePath ($OutPath + ".status.txt") -Force
