/**
 * Screen Capture Module
 *
 * Captures the desktop screen as JPEG frames and streams them
 * via a callback. Uses screenshot-desktop for cross-platform capture
 * and sharp for fast resizing/compression.
 */

const screenshot = require('screenshot-desktop');
const sharp = require('sharp');

class ScreenCapture {
  constructor(options = {}) {
    this.quality = options.quality || 60;
    this.fps = options.fps || 15;
    this.scale = options.scale || 0.5;
    this.streaming = false;
    this.interval = null;
    this.screenWidth = 1920;
    this.screenHeight = 1080;
    this.lastFrame = null;
    this.frameCount = 0;

    // Detect screen resolution
    this._detectScreen();
  }

  async _detectScreen() {
    try {
      const img = await screenshot({ format: 'png' });
      const metadata = await sharp(img).metadata();
      this.screenWidth = metadata.width;
      this.screenHeight = metadata.height;
      console.log(`🖥️  Screen detected: ${this.screenWidth}x${this.screenHeight}`);
    } catch (err) {
      console.warn('⚠️  Could not detect screen size, using defaults');
    }
  }

  getScreenInfo() {
    return {
      width: this.screenWidth,
      height: this.screenHeight,
      scaledWidth: Math.round(this.screenWidth * this.scale),
      scaledHeight: Math.round(this.screenHeight * this.scale),
      quality: this.quality,
      fps: this.fps,
      scale: this.scale
    };
  }

  setQuality(quality) {
    this.quality = Math.min(100, Math.max(10, quality));
    console.log(`📊 Quality set to ${this.quality}`);
  }

  setFPS(fps) {
    this.fps = Math.min(30, Math.max(1, fps));
    if (this.streaming) {
      // Restart with new FPS
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
    if (this.streaming) {
      this.stopStreaming();
    }

    this.streaming = true;
    this._currentCallback = callback;
    this.frameCount = 0;

    console.log(`🎬 Streaming started (${this.fps} FPS, ${this.quality}% quality, ${this.scale}x scale)`);
    this._startInterval(callback);
  }

  _startInterval(callback) {
    const intervalMs = Math.round(1000 / this.fps);

    // Capture loop
    this.interval = setInterval(async () => {
      if (!this.streaming) return;

      try {
        const frame = await this._captureFrame();
        if (frame) {
          this.frameCount++;
          callback({
            data: frame.toString('base64'),
            width: Math.round(this.screenWidth * this.scale),
            height: Math.round(this.screenHeight * this.scale),
            timestamp: Date.now(),
            frame: this.frameCount
          });
        }
      } catch (err) {
        // Skip frame on error (screen lock, permission, etc.)
        if (this.frameCount === 0) {
          console.error('❌ Screen capture error:', err.message);
        }
      }
    }, intervalMs);
  }

  async _captureFrame() {
    // Capture raw screenshot
    const img = await screenshot({ format: 'png' });

    // Resize and compress to JPEG
    const scaledWidth = Math.round(this.screenWidth * this.scale);
    const scaledHeight = Math.round(this.screenHeight * this.scale);

    const frame = await sharp(img)
      .resize(scaledWidth, scaledHeight, {
        fit: 'fill',
        kernel: sharp.kernel.nearest  // Fast, good for screen content
      })
      .jpeg({
        quality: this.quality,
        mozjpeg: false,  // Faster encoding
        chromaSubsampling: '4:2:0'
      })
      .toBuffer();

    return frame;
  }

  stopStreaming() {
    this.streaming = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    console.log(`⏹️  Streaming stopped (${this.frameCount} frames sent)`);
  }
}

module.exports = ScreenCapture;
