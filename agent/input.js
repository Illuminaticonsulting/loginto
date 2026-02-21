/**
 * Input Handler Module
 *
 * Receives mouse/keyboard events from the phone client
 * and injects them into the desktop OS.
 *
 * Uses robotjs for cross-platform input simulation.
 * Falls back to platform-specific commands if robotjs fails.
 *
 * Windows fallback: spawns ONE persistent PowerShell worker at start-up.
 * All input commands are piped to it via stdin — eliminates the ~500 ms
 * per-event cost of spawning a new powershell.exe process every mouse-move.
 * Uses SendInput() (modern Win32 API) instead of the deprecated mouse_event().
 */

// ─── PowerShell worker script (embedded, written to a temp .ps1 on Windows) ─
const WIN_PS_WORKER = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT {
    public int    dx, dy;
    public uint   mouseData, dwFlags, time;
    public IntPtr dwExtraInfo;
}
[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT {
    public ushort wVk, wScan;
    public uint   dwFlags, time;
    public IntPtr dwExtraInfo;
}
[StructLayout(LayoutKind.Sequential)]
public struct HARDWAREINPUT {
    public uint   uMsg;
    public ushort wParamL, wParamH;
}
[StructLayout(LayoutKind.Explicit)]
public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT     mi;
    [FieldOffset(0)] public KEYBDINPUT     ki;
    [FieldOffset(0)] public HARDWAREINPUT  hi;
}
[StructLayout(LayoutKind.Sequential)]
public struct INPUT {
    public uint      type;
    public InputUnion u;
}
public class WinInputHelper {
    [DllImport("user32.dll", SetLastError=true)]
    public static extern uint SendInput(uint n, INPUT[] inp, int cbSize);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern short VkKeyScan(char ch);
}
"@

Add-Type -AssemblyName System.Windows.Forms

$cbSize            = [Runtime.InteropServices.Marshal]::SizeOf([type][INPUT])
$LEFTDOWN          = [uint]0x0002
$LEFTUP            = [uint]0x0004
$RIGHTDOWN         = [uint]0x0008
$RIGHTUP           = [uint]0x0010
$MIDDLEDOWN        = [uint]0x0020
$MIDDLEUP          = [uint]0x0040
$WHEEL             = [uint]0x0800
$HWHEEL            = [uint]0x01000

function Invoke-MouseInput([uint]$flags, [uint]$data) {
    $inp = New-Object INPUT
    $inp.type = 0
    $inp.u.mi.dwFlags   = $flags
    $inp.u.mi.mouseData = $data
    [WinInputHelper]::SendInput(1, @($inp), $cbSize) | Out-Null
}

# Main command loop — reads one line at a time from stdin
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $p = $line.Split('|')
    switch ($p[0]) {
        'MOVE' {
            [WinInputHelper]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null
        }
        'CLICK' {
            [WinInputHelper]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null
            switch ($p[3]) {
                'right'  { Invoke-MouseInput $RIGHTDOWN  0; Invoke-MouseInput $RIGHTUP  0 }
                'middle' { Invoke-MouseInput $MIDDLEDOWN 0; Invoke-MouseInput $MIDDLEUP 0 }
                default  { Invoke-MouseInput $LEFTDOWN   0; Invoke-MouseInput $LEFTUP   0 }
            }
        }
        'DCLICK' {
            [WinInputHelper]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null
            Invoke-MouseInput $LEFTDOWN 0; Invoke-MouseInput $LEFTUP 0
            Start-Sleep -Milliseconds 50
            Invoke-MouseInput $LEFTDOWN 0; Invoke-MouseInput $LEFTUP 0
        }
        'DOWN' {
            [WinInputHelper]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null
            if ($p[3] -eq 'right') { Invoke-MouseInput $RIGHTDOWN 0 } else { Invoke-MouseInput $LEFTDOWN 0 }
        }
        'UP' {
            [WinInputHelper]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null
            if ($p[3] -eq 'right') { Invoke-MouseInput $RIGHTUP 0 } else { Invoke-MouseInput $LEFTUP 0 }
        }
        'SCROLL' {
            [WinInputHelper]::SetCursorPos([int]$p[1], [int]$p[2]) | Out-Null
            $sy = [int]$p[3]; $sx = [int]$p[4]
            if ($sy -ne 0) {
                $amt = [BitConverter]::ToUInt32([BitConverter]::GetBytes($sy * 120), 0)
                Invoke-MouseInput $WHEEL $amt
            }
            if ($sx -ne 0) {
                $amt = [BitConverter]::ToUInt32([BitConverter]::GetBytes($sx * 120), 0)
                Invoke-MouseInput $HWHEEL $amt
            }
        }
        'KEY' {
            # p[1] is already a SendKeys string (e.g. '{ENTER}', '^c', '+{F6}')
            [System.Windows.Forms.SendKeys]::SendWait($p[1])
        }
        'TYPE' {
            # Text may contain '|' — rejoin everything after the command token
            $text = ($p[1..($p.Length - 1)] -join '|')
            [System.Windows.Forms.SendKeys]::SendWait($text)
        }
    }
}
`;

class InputHandler {
  constructor() {
    this.robot = null;
    this.useRobot = false;
    this.screenWidth = 1920;
    this.screenHeight = 1080;
    this._winPs = null;   // persistent PowerShell worker (Windows only)
    this._offsetX = 0;    // global desktop offset of active display (for multi-monitor)
    this._offsetY = 0;

    this._init();
  }

  _init() {
    try {
      this.robot = require('robotjs');
      this.robot.setMouseDelay(0);
      this.robot.setKeyboardDelay(0);
      this.useRobot = true;
      console.log('🎮 Input handler: robotjs loaded');

      // Get actual screen size
      const screenSize = this.robot.getScreenSize();
      this.screenWidth = screenSize.width;
      this.screenHeight = screenSize.height;
    } catch (err) {
      console.warn('⚠️  robotjs not available — using fallback input method');
      console.warn('   Install with: npm install robotjs');
      console.warn('   (Requires Python and C++ build tools)');
      this.useRobot = false;
      this._initFallback();
    }
  }

  _initFallback() {
    this.platform = process.platform;
    console.log(`🎮 Input handler: fallback mode (${this.platform})`);

    if (this.platform === 'win32') {
      // Get screen size once (blocking is fine — startup only)
      try {
        const { execSync } = require('child_process');
        const out = execSync(
          'powershell -NoProfile -Command "[System.Windows.Forms.Screen]::PrimaryScreen.Bounds | Select-Object Width,Height | ConvertTo-Json"',
          { timeout: 5000, encoding: 'utf8' }
        );
        const parsed = JSON.parse(out);
        if (parsed.Width && parsed.Height) {
          this.screenWidth  = parsed.Width;
          this.screenHeight = parsed.Height;
          console.log(`🖥️  Screen size (via PowerShell): ${this.screenWidth}x${this.screenHeight}`);
        }
      } catch (e) {
        try {
          const { execSync } = require('child_process');
          const out = execSync(
            'wmic path Win32_VideoController get CurrentHorizontalResolution,CurrentVerticalResolution /format:value',
            { timeout: 5000, encoding: 'utf8' }
          );
          const hMatch = out.match(/CurrentHorizontalResolution=(\d+)/);
          const vMatch = out.match(/CurrentVerticalResolution=(\d+)/);
          if (hMatch && vMatch) {
            this.screenWidth  = parseInt(hMatch[1]);
            this.screenHeight = parseInt(vMatch[1]);
            console.log(`🖥️  Screen size (via WMIC): ${this.screenWidth}x${this.screenHeight}`);
          }
        } catch (e2) {
          console.warn('⚠️  Could not detect screen size on Windows');
        }
      }

      // Spawn the persistent PowerShell worker
      this._initWindowsPS();
    }
  }

  // ─── Windows: persistent PowerShell worker ──────────────────────────────────

  _initWindowsPS() {
    const { spawn } = require('child_process');
    const fs   = require('fs');
    const path = require('path');
    const os   = require('os');

    // Write the worker script to a temp file so we can pass it as -File
    const scriptPath = path.join(os.tmpdir(), 'loginto-input-worker.ps1');
    try {
      fs.writeFileSync(scriptPath, WIN_PS_WORKER, 'utf8');
    } catch (e) {
      console.error('⚠️  Windows input: failed to write PS worker script:', e.message);
      return;
    }

    try {
      this._winPs = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }
      );

      this._winPs.on('exit', (code) => {
        console.warn(`⚠️  Windows input worker exited (code ${code}) — restarting...`);
        this._winPs = null;
        // Restart after a short delay to avoid rapid-loop on persistent failures
        setTimeout(() => { if (this.platform === 'win32') this._initWindowsPS(); }, 2000);
      });

      this._winPs.on('error', (err) => {
        console.error('⚠️  Windows input worker error:', err.message);
        this._winPs = null;
      });

      console.log('🎮 Windows input worker started (persistent SendInput process)');
    } catch (e) {
      console.error('⚠️  Windows input: failed to spawn PS worker:', e.message);
    }
  }

  /** Send a command line to the persistent PS worker (non-blocking). */
  _winSend(cmd) {
    if (!this._winPs || !this._winPs.stdin.writable) return;
    try {
      this._winPs.stdin.write(cmd + '\n');
    } catch (e) { /* ignore */ }
  }

  /** Update the global desktop offset for the currently active display (multi-monitor). */
  setDisplayOffset(x, y) {
    this._offsetX = x || 0;
    this._offsetY = y || 0;
  }

  // ─── Public input methods ────────────────────────────────────────────────────

  /**
   * Scale coordinates from the client viewport to actual screen coordinates
   * and apply the active display's global desktop offset (multi-monitor support).
   */
  _scaleCoords(x, y, sourceWidth, sourceHeight) {
    const scaledX = Math.round((x / sourceWidth) * this.screenWidth) + this._offsetX;
    const scaledY = Math.round((y / sourceHeight) * this.screenHeight) + this._offsetY;
    return {
      x: Math.max(0, Math.min(65535, scaledX)),
      y: Math.max(0, Math.min(65535, scaledY))
    };
  }

  moveMouse(x, y) {
    const gx = Math.round(x) + this._offsetX;
    const gy = Math.round(y) + this._offsetY;
    if (this.useRobot) {
      try { this.robot.moveMouse(gx, gy); } catch (e) { /* ignore */ }
    } else if (this.platform === 'win32') {
      this._winSend(`MOVE|${gx}|${gy}`);
    } else {
      this._fallbackMoveMouse(gx, gy);
    }
  }

  click(x, y, button = 'left') {
    const gx = Math.round(x) + this._offsetX;
    const gy = Math.round(y) + this._offsetY;
    if (this.useRobot) {
      try {
        this.robot.moveMouse(gx, gy);
        this.robot.mouseClick(button);
      } catch (e) { /* ignore */ }
    } else if (this.platform === 'win32') {
      this._winSend(`CLICK|${gx}|${gy}|${button}`);
    } else {
      this._fallbackClick(gx, gy, button);
    }
  }

  doubleClick(x, y) {
    const gx = Math.round(x) + this._offsetX;
    const gy = Math.round(y) + this._offsetY;
    if (this.useRobot) {
      try {
        this.robot.moveMouse(gx, gy);
        this.robot.mouseClick('left', true);
      } catch (e) { /* ignore */ }
    } else if (this.platform === 'win32') {
      this._winSend(`DCLICK|${gx}|${gy}`);
    } else {
      this._fallbackDoubleClick(gx, gy);
    }
  }

  rightClick(x, y) {
    this.click(x, y, 'right');
  }

  scroll(x, y, deltaX, deltaY) {
    const gx = Math.round(x) + this._offsetX;
    const gy = Math.round(y) + this._offsetY;
    if (this.useRobot) {
      try {
        this.robot.moveMouse(gx, gy);
        if (deltaY !== 0) this.robot.scrollMouse(0, deltaY > 0 ? -3 : 3);
        if (deltaX !== 0) this.robot.scrollMouse(deltaX > 0 ? -3 : 3, 0);
      } catch (e) { /* ignore */ }
    } else if (this.platform === 'win32') {
      // Positive sy = WHEEL_DELTA positive = scroll up; negate deltaY (browser positive = down)
      const sy = deltaY !== 0 ? (deltaY > 0 ? -3 : 3) : 0;
      const sx = deltaX !== 0 ? (deltaX > 0 ? -3 : 3) : 0;
      this._winSend(`SCROLL|${gx}|${gy}|${sy}|${sx}`);
    }
    // Linux: no scroll fallback (xdotool scroll not reliable without click)
  }

  mouseDown(x, y, button = 'left') {
    const gx = Math.round(x) + this._offsetX;
    const gy = Math.round(y) + this._offsetY;
    if (this.useRobot) {
      try {
        this.robot.moveMouse(gx, gy);
        this.robot.mouseToggle('down', button);
      } catch (e) { /* ignore */ }
    } else if (this.platform === 'win32') {
      this._winSend(`DOWN|${gx}|${gy}|${button}`);
    } else {
      this._fallbackMouseDown(gx, gy, button);
    }
  }

  mouseUp(x, y, button = 'left') {
    const gx = Math.round(x) + this._offsetX;
    const gy = Math.round(y) + this._offsetY;
    if (this.useRobot) {
      try {
        this.robot.moveMouse(gx, gy);
        this.robot.mouseToggle('up', button);
      } catch (e) { /* ignore */ }
    } else if (this.platform === 'win32') {
      this._winSend(`UP|${gx}|${gy}|${button}`);
    } else {
      this._fallbackMouseUp(gx, gy, button);
    }
  }

  keyPress(key, modifiers = []) {
    if (this.useRobot) {
      try {
        const keyMap = {
          'Enter': 'enter', 'Backspace': 'backspace', 'Tab': 'tab',
          'Escape': 'escape', 'Delete': 'delete',
          'ArrowUp': 'up', 'ArrowDown': 'down', 'ArrowLeft': 'left', 'ArrowRight': 'right',
          'Home': 'home', 'End': 'end', 'PageUp': 'pageup', 'PageDown': 'pagedown',
          ' ': 'space', 'Space': 'space',
          'Meta': 'command', 'Control': 'control', 'Alt': 'alt', 'Shift': 'shift',
          'CapsLock': 'caps_lock', 'PrintScreen': 'printscreen', 'Insert': 'insert',
          'F1': 'f1', 'F2': 'f2', 'F3': 'f3', 'F4': 'f4',
          'F5': 'f5', 'F6': 'f6', 'F7': 'f7', 'F8': 'f8',
          'F9': 'f9', 'F10': 'f10', 'F11': 'f11', 'F12': 'f12',
        };
        const robotKey = keyMap[key] || key.toLowerCase();
        const robotModifiers = modifiers.map(m => {
          const modMap = { 'ctrl': 'control', 'meta': 'command', 'cmd': 'command', 'alt': 'alt', 'shift': 'shift' };
          return modMap[m.toLowerCase()] || m.toLowerCase();
        });
        const modifierKeys = ['control', 'command', 'alt', 'shift', 'caps_lock'];
        if (modifierKeys.includes(robotKey) && robotModifiers.length === 0) return;
        this.robot.keyTap(robotKey, robotModifiers);
      } catch (e) { /* ignore */ }
    } else if (this.platform === 'win32') {
      const winKeyMap = {
        'Enter': '{ENTER}', 'Backspace': '{BACKSPACE}', 'Tab': '{TAB}',
        'Escape': '{ESC}', 'Delete': '{DELETE}',
        'ArrowUp': '{UP}', 'ArrowDown': '{DOWN}', 'ArrowLeft': '{LEFT}', 'ArrowRight': '{RIGHT}',
        'Home': '{HOME}', 'End': '{END}', 'PageUp': '{PGUP}', 'PageDown': '{PGDN}',
        'Space': ' ', 'Insert': '{INSERT}',
        'F1': '{F1}', 'F2': '{F2}', 'F3': '{F3}', 'F4': '{F4}',
        'F5': '{F5}', 'F6': '{F6}', 'F7': '{F7}', 'F8': '{F8}',
        'F9': '{F9}', 'F10': '{F10}', 'F11': '{F11}', 'F12': '{F12}',
      };
      let sendKey = winKeyMap[key] || key;
      for (const m of modifiers) {
        if (m === 'ctrl')  sendKey = '^'  + sendKey;
        else if (m === 'alt')   sendKey = '%'  + sendKey;
        else if (m === 'shift') sendKey = '+'  + sendKey;
        else if (m === 'meta' || m === 'cmd') sendKey = '^' + sendKey; // Best effort: Ctrl as Win-key sub
      }
      this._winSend('KEY|' + sendKey);
    } else {
      this._fallbackKeyPress(key, modifiers);
    }
  }

  typeText(text) {
    if (this.useRobot) {
      try { this.robot.typeString(text); } catch (e) { /* ignore */ }
    } else if (this.platform === 'win32') {
      // Escape special SendKeys characters: + ^ % ~ { } [ ] ( )
      const escaped = text.replace(/([+^%~{}[\]()])/g, '{$1}');
      this._winSend('TYPE|' + escaped);
    } else {
      this._fallbackTypeText(text);
    }
  }

  // ─── macOS / Linux fallback methods ──────────────────────────────────────────

  _fallbackMoveMouse(x, y) {
    const { execSync } = require('child_process');
    try {
      if (this.platform === 'darwin') {
        execSync(`osascript -e 'tell application "System Events" to set position of the cursor to {${Math.round(x)}, ${Math.round(y)}}'`, { timeout: 500 });
      } else if (this.platform === 'linux') {
        execSync(`xdotool mousemove ${Math.round(x)} ${Math.round(y)}`, { timeout: 500 });
      }
    } catch (e) { /* ignore */ }
  }

  _fallbackClick(x, y, button = 'left') {
    const { execSync } = require('child_process');
    try {
      if (this.platform === 'darwin') {
        execSync(`osascript -e '
          tell application "System Events"
            click at {${Math.round(x)}, ${Math.round(y)}}
          end tell
        '`, { timeout: 1000 });
      } else if (this.platform === 'linux') {
        const btn = button === 'right' ? '3' : '1';
        execSync(`xdotool mousemove ${Math.round(x)} ${Math.round(y)} click ${btn}`, { timeout: 500 });
      }
    } catch (e) { /* ignore */ }
  }

  _fallbackDoubleClick(x, y) {
    const { execSync } = require('child_process');
    try {
      if (this.platform === 'linux') {
        execSync(`xdotool mousemove ${Math.round(x)} ${Math.round(y)} click --repeat 2 1`, { timeout: 500 });
      }
    } catch (e) { /* ignore */ }
  }

  _fallbackMouseDown(x, y, button = 'left') {
    const { execSync } = require('child_process');
    try {
      if (this.platform === 'linux') {
        const btn = button === 'right' ? '3' : '1';
        execSync(`xdotool mousemove ${Math.round(x)} ${Math.round(y)} mousedown ${btn}`, { timeout: 500 });
      }
    } catch (e) { /* ignore */ }
  }

  _fallbackMouseUp(x, y, button = 'left') {
    const { execSync } = require('child_process');
    try {
      if (this.platform === 'linux') {
        const btn = button === 'right' ? '3' : '1';
        execSync(`xdotool mousemove ${Math.round(x)} ${Math.round(y)} mouseup ${btn}`, { timeout: 500 });
      }
    } catch (e) { /* ignore */ }
  }

  _fallbackKeyPress(key, modifiers) {
    const { execSync } = require('child_process');
    try {
      if (this.platform === 'linux') {
        const keyName = key;
        if (modifiers.length > 0) {
          execSync(`xdotool key ${modifiers.join('+')}+${keyName}`, { timeout: 500 });
        } else {
          execSync(`xdotool key ${keyName}`, { timeout: 500 });
        }
      }
    } catch (e) { /* ignore */ }
  }

  _fallbackTypeText(text) {
    const { execSync } = require('child_process');
    try {
      if (this.platform === 'linux') {
        execSync(`xdotool type --clearmodifiers "${text.replace(/"/g, '\\"')}"`, { timeout: 2000 });
      }
    } catch (e) { /* ignore */ }
  }

  // ─── Clipboard ──────────────────────────────────────────────────────────────

  getClipboard() {
    const { execSync } = require('child_process');
    try {
      if (process.platform === 'darwin') {
        return execSync('pbpaste', { timeout: 1000, encoding: 'utf8' });
      } else if (process.platform === 'linux') {
        return execSync('xclip -selection clipboard -o', { timeout: 1000, encoding: 'utf8' });
      } else if (process.platform === 'win32') {
        return execSync('powershell -NoProfile -Command "Get-Clipboard"', { timeout: 1000, encoding: 'utf8' }).trim();
      }
    } catch (e) { return ''; }
    return '';
  }

  setClipboard(text) {
    const { execSync } = require('child_process');
    try {
      if (process.platform === 'darwin') {
        execSync('pbcopy', { input: text, timeout: 1000 });
      } else if (process.platform === 'linux') {
        execSync('xclip -selection clipboard', { input: text, timeout: 1000 });
      } else if (process.platform === 'win32') {
        execSync('clip', { input: text, timeout: 1000 });
      }
    } catch (e) { /* ignore */ }
  }

  /** Clean up worker process on agent shutdown. */
  destroy() {
    if (this._winPs) {
      try { this._winPs.stdin.end(); } catch (_) {}
      try { this._winPs.kill(); } catch (_) {}
      this._winPs = null;
    }
  }
}

module.exports = InputHandler;
