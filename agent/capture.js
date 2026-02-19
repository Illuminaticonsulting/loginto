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
      displayCount: this.displays.length
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
