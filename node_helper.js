/* Magic Mirror
 * Node Helper: MMM-Ring
 *
 * By Dustin Bryant
 * MIT Licensed.
 *
 * Huge thanks to dgreif on GitHub for the RingAPI and
 * examples which resulted in ability to create this
 * Magic Mirror module.
 * https://github.com/dgreif/ring
 */

const NodeHelper = require("node_helper");
const pathApi = require("path");
const util = require("util");
const fs = require("fs");
const mainRingApi = require("ring-client-api");
const operators = require("rxjs/operators");
const fileWatcher = require("chokidar");

module.exports = NodeHelper.create({
  requiresVersion: "2.11.0",

  start: function () {
    this.toLog("Starting module: MMM-Ring");
    this.videoOutputDirectory = pathApi.join(this.path, "public");
    this.envFile = pathApi.join(this.path, ".env");
    this.ringApi = null;
    this.config = null;
    this.watcher = null;
    this.audioPlaylistFile = "stream.m3u8";
    this.sipSession = null;
    this.sessionRunning = false;
  },

  stop: function () {
    this.toLog("Stopping module helper: MMM-Ring");
    this.stopWatchingFile();

    if (this.sipSession) {
      this.sipSession.stop();
      this.sipSession = null;
    }

    this.cleanUpVideoStreamDirectory();
  },

  socketNotificationReceived: async function (notification, payload) {
    if (notification === "BEGIN_RING_MONITORING") {
      this.config = payload;

      if (!(await util.promisify(fs.exists)(this.envFile))) {
        await util.promisify(fs.writeFile)(
          this.envFile,
          `RING_2FA_REFRESH_TOKEN=${this.config.ring2faRefreshToken}`
        );
      }

      require("dotenv").config({ path: this.envFile });

      this.monitorRingActivity();
    }
  },

  cleanUpVideoStreamDirectory: async function () {
    if (!(await util.promisify(fs.exists)(this.videoOutputDirectory))) {
      await util.promisify(fs.mkdir)(this.videoOutputDirectory);
    }

    const files = await util.promisify(fs.readdir)(this.videoOutputDirectory);
    const unlinkPromises = files.map((filename) =>
      util.promisify(fs.unlink)(`${this.videoOutputDirectory}/${filename}`)
    );
    return await Promise.all(unlinkPromises);
  },

  monitorRingActivity: async function () {
    try {
      // Initialize Ring API with the refresh token
      this.ringApi = new mainRingApi.RingApi({
        refreshToken: process.env.RING_2FA_REFRESH_TOKEN,
        debug: true,
        // Camera settings are now handled differently
        cameraStatusPollingSeconds: 20,
        locationModePollingSeconds: 20
      });

      // Handle token refresh
      this.ringApi.onRefreshTokenUpdated.subscribe(
        async ({ newRefreshToken, oldRefreshToken }) => {
          this.toLog("Refresh Token Updated");
          if (!oldRefreshToken) return;

          const currentConfig = await util.promisify(fs.readFile)(this.envFile);
          const updateConfig = currentConfig
            .toString()
            .replace(oldRefreshToken, newRefreshToken);
          await util.promisify(fs.writeFile)(this.envFile, updateConfig);
        }
      );

      // Get locations and cameras
      const locations = await this.ringApi.getLocations();
      const allCameras = await this.ringApi.getCameras();

      this.toLog(
        `Found ${locations.length} location(s) with ${allCameras.length} camera(s).`
      );

      // Set up camera event listeners
      for (const camera of allCameras) {
        // New way to handle doorbell events
        camera.onDoorbellPressed.subscribe(async () => {
          if (!this.sipSession) {
            await this.startSession(camera, "ring");
          }
        });

        // Handle motion events if enabled
        if (this.config.ringStreamMotion) {
          camera.onMotionDetected.subscribe(async (motion) => {
            if (!this.sipSession && motion) {
              await this.startSession(camera, "motion");
            }
          });
        }

        // Set up live streaming
        camera.subscribeToMotionEvents().subscribe((motion) => {
          this.toLog(`Motion detected on ${camera.name}: ${motion}`);
        });
      }

    } catch (error) {
      this.toLog(`Error in monitorRingActivity: ${error.message}`);
      this.sendSocketNotification(
        "DISPLAY_ERROR",
        "Failed to initialize Ring connection. Check your refresh token."
      );
    }
  },

  startSession: async function (camera, type) {
    if (this.sipSession || this.sessionRunning === true) {
      return;
    }

    this.sessionRunning = true;
    this.toLog(`${camera.name} ${type === "ring" ? "doorbell pressed" : "motion detected"}. Preparing stream.`);

    await this.cleanUpVideoStreamDirectory();
    this.watchForStreamStarted();

    const streamTimeOut = this.config.ringMinutesToStreamVideo * 60 * 1000;
    
    try {
      this.sipSession = await camera.createRtpStreamingSession({
        output: [
          "-preset", "veryfast",
          "-g", "25",
          "-sc_threshold", "0",
          "-f", "hls",
          "-hls_time", "2",
          "-hls_list_size", "6",
          "-hls_flags", "delete_segments",
          pathApi.join(this.videoOutputDirectory, this.audioPlaylistFile)
        ]
      });

      this.sipSession.onCallEnded.subscribe(() => {
        this.toLog(`${camera.name} video stream has ended`);
        this.sendSocketNotification("VIDEO_STREAM_ENDED", null);
        this.stopWatchingFile();
        this.sipSession = null;
        this.sessionRunning = false;
      });

      setTimeout(() => {
        if (this.sipSession) {
          this.sipSession.stop();
        }
      }, streamTimeOut);

    } catch (error) {
      this.toLog(`Error starting stream: ${error.message}`);
      this.sessionRunning = false;
    }
  },

  stopWatchingFile: function () {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  },

  toLog: function (message) {
    console.log(`MMM-Ring at (${new Date().toLocaleString()}): ${message}`);
  },

  watchForStreamStarted: function () {
    this.stopWatchingFile();

    // only watch for file for 15 seconds
    setTimeout(() => this.stopWatchingFile(), 15 * 1000);

    this.watcher = fileWatcher.watch(this.videoOutputDirectory, {
      ignored: /(^|[\/\\])\../,
      persistent: true
    });

    this.watcher.on("add", (filePath) => {
      var fileName = filePath.split("\\").pop().split("/").pop();

      if (fileName === this.audioPlaylistFile) {
        this.stopWatchingFile();
        this.sendSocketNotification("VIDEO_STREAM_AVAILABLE", null);
      }
    });
  }
});
