/**
 * Input Handler Module
 *
 * Receives mouse/keyboard events from the phone client
 * and injects them into the desktop OS.
 *
 * Uses robotjs for cross-platform input simulation.
 * Falls back to platform-specific commands if robotjs fails.
 */

class InputHandler {
  constructor() {
    this.robot = null;
    this.useRobot = false;
    this.screenWidth = 1920;
    this.screenHeight = 1080;

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
    // Detect platform for fallback commands
    this.platform = process.platform;
    console.log(`🎮 Input handler: fallback mode (${this.platform})`);
  }

  /**
   * Scale coordinates from the client viewport to actual screen coordinates
   */
  _scaleCoords(x, y, sourceWidth, sourceHeight) {
    const scaledX = Math.round((x / sourceWidth) * this.screenWidth);
    const scaledY = Math.round((y / sourceHeight) * this.screenHeight);
    return {
      x: Math.max(0, Math.min(this.screenWidth - 1, scaledX)),
      y: Math.max(0, Math.min(this.screenHeight - 1, scaledY))
    };
  }

  /**
   * Move mouse to position
   */
  moveMouse(x, y) {
    if (this.useRobot) {
      try {
        this.robot.moveMouse(Math.round(x), Math.round(y));
      } catch (e) { /* ignore */ }
    } else {
      this._fallbackMoveMouse(x, y);
    }
  }

  /**
   * Click at position
   */
  click(x, y, button = 'left') {
    if (this.useRobot) {
      try {
        this.robot.moveMouse(Math.round(x), Math.round(y));
        this.robot.mouseClick(button);
      } catch (e) { /* ignore */ }
    } else {
      this._fallbackClick(x, y, button);
    }
  }

  /**
   * Double-click at position
   */
  doubleClick(x, y) {
    if (this.useRobot) {
      try {
        this.robot.moveMouse(Math.round(x), Math.round(y));
        this.robot.mouseClick('left', true);
      } catch (e) { /* ignore */ }
    } else {
      this._fallbackDoubleClick(x, y);
    }
  }

  /**
   * Right-click at position
   */
  rightClick(x, y) {
    this.click(x, y, 'right');
  }

  /**
   * Scroll at position
   */
  scroll(x, y, deltaX, deltaY) {
    if (this.useRobot) {
      try {
        this.robot.moveMouse(Math.round(x), Math.round(y));
        if (deltaY !== 0) {
          this.robot.scrollMouse(0, deltaY > 0 ? -3 : 3);
        }
        if (deltaX !== 0) {
          this.robot.scrollMouse(deltaX > 0 ? -3 : 3, 0);
        }
      } catch (e) { /* ignore */ }
    }
  }

  /**
   * Press mouse button down (for dragging)
   */
  mouseDown(x, y, button = 'left') {
    if (this.useRobot) {
      try {
        this.robot.moveMouse(Math.round(x), Math.round(y));
        this.robot.mouseToggle('down', button);
      } catch (e) { /* ignore */ }
    } else {
      this._fallbackMouseDown(x, y, button);
    }
  }

  /**
   * Release mouse button (end dragging)
   */
  mouseUp(x, y, button = 'left') {
    if (this.useRobot) {
      try {
        this.robot.moveMouse(Math.round(x), Math.round(y));
        this.robot.mouseToggle('up', button);
      } catch (e) { /* ignore */ }
    } else {
      this._fallbackMouseUp(x, y, button);
    }
  }

  /**
   * Press a key with optional modifiers
   */
  keyPress(key, modifiers = []) {
    if (this.useRobot) {
      try {
        // Map common key names
        const keyMap = {
          'Enter': 'enter',
          'Backspace': 'backspace',
          'Tab': 'tab',
          'Escape': 'escape',
          'Delete': 'delete',
          'ArrowUp': 'up',
          'ArrowDown': 'down',
          'ArrowLeft': 'left',
          'ArrowRight': 'right',
          'Home': 'home',
          'End': 'end',
          'PageUp': 'pageup',
          'PageDown': 'pagedown',
          ' ': 'space',
          'Space': 'space',
          'Meta': 'command',
          'Control': 'control',
          'Alt': 'alt',
          'Shift': 'shift',
          'CapsLock': 'caps_lock',
          'PrintScreen': 'printscreen',
          'Insert': 'insert',
          'F1': 'f1', 'F2': 'f2', 'F3': 'f3', 'F4': 'f4',
          'F5': 'f5', 'F6': 'f6', 'F7': 'f7', 'F8': 'f8',
          'F9': 'f9', 'F10': 'f10', 'F11': 'f11', 'F12': 'f12',
        };

        const robotKey = keyMap[key] || key.toLowerCase();
        const robotModifiers = modifiers.map(m => {
          const modMap = {
            'ctrl': 'control',
            'meta': 'command',
            'cmd': 'command',
            'alt': 'alt',
            'shift': 'shift'
          };
          return modMap[m.toLowerCase()] || m.toLowerCase();
        });

        // Don't try to tap modifier keys alone as a combo
        const modifierKeys = ['control', 'command', 'alt', 'shift', 'caps_lock'];
        if (modifierKeys.includes(robotKey) && robotModifiers.length === 0) {
          return; // Skip lone modifier key presses
        }

        this.robot.keyTap(robotKey, robotModifiers);
      } catch (e) {
        // Silently ignore unsupported keys
      }
    } else {
      this._fallbackKeyPress(key, modifiers);
    }
  }

  /**
   * Type a string of text
   */
  typeText(text) {
    if (this.useRobot) {
      try {
        this.robot.typeString(text);
      } catch (e) { /* ignore */ }
    } else {
      this._fallbackTypeText(text);
    }
  }

  // ─── Fallback Methods (AppleScript on Mac, xdotool on Linux) ───

  _fallbackMoveMouse(x, y) {
    const { execSync } = require('child_process');
    try {
      if (this.platform === 'darwin') {
        // macOS: use cliclick if available, or AppleScript
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
        const btn = button === 'right' ? 'right' : 'left';
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
        const keyName = key.length === 1 ? key : key;
        if (modifiers.length > 0) {
          const mods = modifiers.join('+');
          execSync(`xdotool key ${mods}+${keyName}`, { timeout: 500 });
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

  // ─── Clipboard ──────────────────────────────────────────

  getClipboard() {
    const { execSync } = require('child_process');
    try {
      if (process.platform === 'darwin') {
        return execSync('pbpaste', { timeout: 1000, encoding: 'utf8' });
      } else if (process.platform === 'linux') {
        return execSync('xclip -selection clipboard -o', { timeout: 1000, encoding: 'utf8' });
      } else if (process.platform === 'win32') {
        return execSync('powershell -command "Get-Clipboard"', { timeout: 1000, encoding: 'utf8' }).trim();
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
}

module.exports = InputHandler;
