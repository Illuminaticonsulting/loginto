/**
 * Screen Capture Module
 *
 * Captures the desktop screen as JPEG frames and streams them.
 * Uses screenshot-desktop for cross-platform capture and sharp
 * for fast resizing/compression.
 *
 * Key quality settings (like LogMeIn):
 *  - 4:4:4 chroma subsampling (no color blur on text)
 *  - lanczos3 resampling (sharp downscale, no jagged edges)
 *  - Multi-monitor support via listDisplays / switchDisplay
 */

const screenshot = require('screenshot-desktop');
const sharp = require('sharp');
const crypto = require('crypto');

class ScreenCapture {
  constructor(options = {}) {
    this.quality = options.quality || 92;
    this.fps = options.fps || 20;
    this.scale = options.scale || 1.0;
    this.streaming = false;
    this.interval = null;
    this.screenWidth = 1920;
    this.screenHeight = 1080;
    this.lastFrame = null;
    this.lastFrameHash = null;
    this.frameCount = 0;
    this.skippedFrames = 0;
    this.capturing = false;

    // Adaptive quality
    this.adaptiveEnabled = true;
    this.targetFPS = this.fps;
    this.actualFPS = 0;
    this._fpsCounter = 0;
    this._lastFPSCheck = Date.now();
    this.minQuality = 40;
    this.maxQuality = 95;

    // Multi-monitor
    this.displays = [];        // [{ id, name }, ...]
    this.activeDisplayId = null; // null = default/primary
    this.activeDisplayOffset = { x: 0, y: 0 }; // top-left of active display in global desktop coords
    this._displayOffsets = {};  // displayId → { x, y }

    // Detect screen resolution + displays
    this._detectScreen();
  }

  async _detectScreen() {
    try {
      // List all displays
      try {
        this.displays = await screenshot.listDisplays();
        if (this.displays.length > 0) {
          this.activeDisplayId = this.displays[0].id;
          console.log(`🖥️  Displays found: ${this.displays.length}`);
          this.displays.forEach((d, i) => {
            console.log(`   ${i + 1}. ${d.name || 'Display ' + (i + 1)} (id: ${d.id})`);
          });
          // Detect position offsets for each display in global desktop space
          await this._detectDisplayOffsets();
          this.activeDisplayOffset = this._displayOffsets[String(this.activeDisplayId)] || { x: 0, y: 0 };
          if (this.activeDisplayOffset.x || this.activeDisplayOffset.y) {
            console.log(`🖥️  Primary display offset: (${this.activeDisplayOffset.x}, ${this.activeDisplayOffset.y})`);
          }
        }
      } catch (e) {
        console.log('   ℹ️  Multi-monitor detection not available');
      }

      // Capture a test frame to get resolution
      const captureOpts = { format: 'png' };
      if (this.activeDisplayId != null) captureOpts.screen = this.activeDisplayId;
      const img = await screenshot(captureOpts);
      const metadata = await sharp(img).metadata();
      this.screenWidth = metadata.width;
      this.screenHeight = metadata.height;
      console.log(`🖥️  Active screen: ${this.screenWidth}x${this.screenHeight}`);

      // Auto-detect retina
      if (this.scale >= 1.0 && (this.screenWidth > 2500 || this.screenHeight > 1600)) {
        this.scale = 0.5;
        console.log(`🔍 Retina detected — auto-scaling to 0.5x (${Math.round(this.screenWidth * this.scale)}x${Math.round(this.screenHeight * this.scale)})`);
      }
    } catch (err) {
      console.warn('⚠️  Could not detect screen size, using defaults');
    }
  }

  getDisplays() {
    return this.displays.map((d, i) => ({
      id: d.id,
      name: d.name || 'Display ' + (i + 1),
      active: d.id === this.activeDisplayId
    }));
  }

  // ─── Display offset detection (position in global desktop space) ─────────────
  async _detectDisplayOffsets() {
    this._displayOffsets = {};
    if (this.displays.length <= 1) return; // single display: offset is always (0,0)

    try {
      const { execSync } = require('child_process');

      if (process.platform === 'darwin') {
        // Use Python3 + CoreGraphics to get CGDisplayBounds (global desktop coords)
        const py = [
          'try:',
          ' from Quartz.CoreGraphics import CGGetActiveDisplayList,CGDisplayBounds',
          ' import json',
          ' e,ids,n=CGGetActiveDisplayList(16,None,None)',
          ' r={}',
          ' [r.__setitem__(str(ids[i]),{"x":int(CGDisplayBounds(ids[i]).origin.x),"y":int(CGDisplayBounds(ids[i]).origin.y)}) for i in range(n)]',
          ' print(json.dumps(r))',
          'except:print("{}")'
        ].join('\n');
        const out = execSync(`python3 -c '${py}'`, { timeout: 5000, encoding: 'utf8' });
        this._displayOffsets = JSON.parse(out.trim() || '{}');

      } else if (process.platform === 'win32') {
        // Use PowerShell to enumerate monitor bounds in virtual desktop space
        const out = execSync(
          'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; ' +
          '[System.Windows.Forms.Screen]::AllScreens | foreach { $b=$_.Bounds; Write-Output \\"$($b.X),$($b.Y)\\" }"',
          { timeout: 5000, encoding: 'utf8', windowsHide: true }
        );
        const lines = out.trim().split('\n').map(l => l.trim()).filter(Boolean);
        // Match by index — screenshot-desktop and Screen.AllScreens both use EnumDisplayMonitors order
        this.displays.forEach((d, i) => {
          if (lines[i]) {
            const parts = lines[i].split(',');
            this._displayOffsets[String(d.id)] = { x: parseInt(parts[0]) || 0, y: parseInt(parts[1]) || 0 };
          }
        });
      }

      if (Object.keys(this._displayOffsets).length > 0) {
        console.log('🖥️  Display offsets detected:', JSON.stringify(this._displayOffsets));
      }
    } catch (e) {
      // Detection failed — all offsets stay at (0,0)
      console.log('   ℹ️  Display offset detection failed — using (0,0) offsets');
    }
  }

  async switchDisplay(displayId) {
    const display = this.displays.find(d => d.id === displayId || String(d.id) === String(displayId));
    if (!display) {
      console.warn(`⚠️  Display ${displayId} not found`);
      return null;
    }

    const wasStreaming = this.streaming;
    const cb = this._currentCallback;
    if (wasStreaming) this.stopStreaming();

    this.activeDisplayId = display.id;
    console.log(`📺 Switched to display: ${display.name || display.id}`);

    // Re-detect resolution for new display
    try {
      const img = await screenshot({ format: 'png', screen: this.activeDisplayId });
      const metadata = await sharp(img).metadata();
      this.screenWidth = metadata.width;
      this.screenHeight = metadata.height;

      // Re-check retina for this display
      this.scale = 1.0;
      if (this.screenWidth > 2500 || this.screenHeight > 1600) {
        this.scale = 0.5;
      }
      console.log(`🖥️  New screen: ${this.screenWidth}x${this.screenHeight} (scale ${this.scale}x)`);
    } catch (e) {
      console.warn('⚠️  Could not detect new display size');
    }

    // Resume streaming if it was running
    if (wasStreaming && cb) this.startStreaming(cb);

    // Update active display offset
    this.activeDisplayOffset = this._displayOffsets[String(this.activeDisplayId)] || { x: 0, y: 0 };
    console.log(`🖥️  Display ${this.activeDisplayId} offset: (${this.activeDisplayOffset.x}, ${this.activeDisplayOffset.y})`);

    return this.getScreenInfo();
  }

  getScreenInfo() {
    const sw = Math.round(this.screenWidth * this.scale);
    const sh = Math.round(this.screenHeight * this.scale);
    return {
      width: this.screenWidth,
      height: this.screenHeight,
      scaledWidth: sw,
      scaledHeight: sh,
      quality: this.quality,
      fps: this.fps,
      scale: this.scale,
      displayId: this.activeDisplayId,
      displayCount: this.displays.length,
      offsetX: this.activeDisplayOffset?.x || 0,
      offsetY: this.activeDisplayOffset?.y || 0
    };
  }

  setQuality(quality) {
    this.quality = Math.min(100, Math.max(10, quality));
    console.log(`📊 Quality set to ${this.quality}`);
  }

  setFPS(fps) {
    this.fps = Math.min(30, Math.max(1, fps));
    if (this.streaming) {
      clearInterval(this.interval);
      this._startInterval(this._currentCallback);
    }
    console.log(`🎞️  FPS set to ${this.fps}`);
  }

  setScale(scale) {
    this.scale = Math.min(1, Math.max(0.1, scale));
    console.log(`🔍 Scale set to ${this.scale}`);
  }

  startStreaming(callback) {
    if (this.streaming) this.stopStreaming();
    this.streaming = true;
    this._currentCallback = callback;
    this.frameCount = 0;
    console.log(`🎬 Streaming: ${this.fps} FPS, quality ${this.quality}, scale ${this.scale}x, display ${this.activeDisplayId}`);
    this._startInterval(callback);
  }

  _startInterval(callback) {
    const intervalMs = Math.round(1000 / this.fps);

    // Adaptive quality check every 2 seconds
    this._adaptiveInterval = setInterval(() => this._adaptiveCheck(), 2000);

    // Use setTimeout chaining instead of setInterval to prevent overlapping captures
    const captureLoop = async () => {
      if (!this.streaming) return;
      const loopStart = Date.now();

      try {
        const frame = await this._captureFrame();
        if (frame && this.streaming) {
          // Idle frame detection: hash & skip if identical
          const hash = crypto.createHash('md5').update(frame).digest('hex');
          if (hash === this.lastFrameHash) {
            this.skippedFrames++;
          } else {
            this.lastFrameHash = hash;
            this.frameCount++;
            this._fpsCounter++;
            // Send raw buffer (binary) instead of base64 — 33% less bandwidth
            callback({
              buf: frame,
              width: Math.round(this.screenWidth * this.scale),
              height: Math.round(this.screenHeight * this.scale),
              timestamp: Date.now(),
              frame: this.frameCount
            });
          }
        }
      } catch (err) {
        if (this.frameCount === 0) {
          console.error('❌ Screen capture error:', err.message);
        }
      }

      // Schedule next capture accounting for actual capture time
      if (this.streaming) {
        const elapsed = Date.now() - loopStart;
        const delay = Math.max(0, intervalMs - elapsed);
        this.interval = setTimeout(captureLoop, delay);
      }
    };
    this.interval = setTimeout(captureLoop, 0);
  }

  _adaptiveCheck() {
    if (!this.adaptiveEnabled) return;
    const now = Date.now();
    const elapsed = (now - this._lastFPSCheck) / 1000;
    this.actualFPS = Math.round(this._fpsCounter / elapsed);
    this._fpsCounter = 0;
    this._lastFPSCheck = now;

    // If actual FPS < 70% of target, reduce quality
    if (this.actualFPS < this.targetFPS * 0.7 && this.quality > this.minQuality) {
      this.quality = Math.max(this.minQuality, this.quality - 5);
      console.log(`📉 Adaptive: quality → ${this.quality} (actual ${this.actualFPS}/${this.targetFPS} FPS)`);
    }
    // If hitting target comfortably, slowly increase
    else if (this.actualFPS >= this.targetFPS * 0.95 && this.quality < this.maxQuality) {
      this.quality = Math.min(this.maxQuality, this.quality + 2);
    }
  }

  async _captureFrame() {
    const captureOpts = { format: 'png' };
    if (this.activeDisplayId != null) captureOpts.screen = this.activeDisplayId;
    const img = await screenshot(captureOpts);

    let pipeline = sharp(img);

    if (this.scale < 0.99) {
      pipeline = pipeline.resize(
        Math.round(this.screenWidth * this.scale),
        Math.round(this.screenHeight * this.scale),
        { fit: 'fill', kernel: sharp.kernel.lanczos3 }
      );
    }

    const frame = await pipeline
      .jpeg({
        quality: this.quality,
        mozjpeg: false,
        chromaSubsampling: '4:4:4'
      })
      .toBuffer();

    return frame;
  }

  stopStreaming() {
    this.streaming = false;
    if (this.interval) {
      clearTimeout(this.interval);
      this.interval = null;
    }
    if (this._adaptiveInterval) {
      clearInterval(this._adaptiveInterval);
      this._adaptiveInterval = null;
    }
    console.log(`⏹️  Streaming stopped (${this.frameCount} frames sent, ${this.skippedFrames} idle skipped)`);
  }
}

module.exports = ScreenCapture;
