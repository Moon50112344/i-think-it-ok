/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { vmService } from './src/server/vmService';
import { assetManager } from './src/server/assetManager';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadDir = path.join(path.resolve(__dirname), '.uploads');

try {
  fs.mkdirSync(uploadDir, { recursive: true });
} catch (err) {
  console.error('[Upload] Cannot prepare upload directory:', err);
}

const upload = multer({ dest: uploadDir });

async function startServer() {
  const app = express();
  const PORT = process.env.PORT
    ? parseInt(process.env.PORT, 10)
    : 3000;

  app.use(express.json());

  // --- API Endpoints ---

  // Host system information
  app.get('/api/system-info', async (_req, res) => {
    try {
      const vms = await vmService.listVMs();

      res.json({
        host: {
          os: 'Debian GNU/Linux 12 (bookworm)',
          kernel: '4.19.0-gvisor x86_64',
          emulator: 'QEMU 7.2.22 (TCG high-performance JIT mode)',
          adbVersion: '1.0.41',
          totalMemoryMb: 12288,
          totalDiskGb: 283,
          maxVms: 3,
        },
        activeVmsCount: vms.filter(
          v => v.status === 'running' || v.status === 'booting'
        ).length,
        totalVmsCount: vms.length,
      });
    } catch (err: any) {
      console.error('[API] system-info failed:', err);
      res.status(500).json({
        error: err?.message || 'Unable to retrieve system information',
      });
    }
  });

  // List all VMs
  app.get('/api/vms', async (_req, res) => {
    try {
      res.json(await vmService.listVMs());
    } catch (err: any) {
      console.error('[API] list VMs failed:', err);
      res.status(500).json({
        error: err?.message || 'Unable to list virtual machines',
      });
    }
  });

  // Create a new VM
  app.post('/api/vms', async (req, res) => {
    try {
      const { name, ramMb, cpuCores } = req.body;
      const newVm = await vmService.createVM(name, ramMb, cpuCores);
      res.status(201).json(newVm);
    } catch (err: any) {
      console.error('[API] create VM failed:', err);
      res.status(400).json({
        error: err?.message || 'Unable to create virtual machine',
      });
    }
  });

  // Get specific VM info
  app.get('/api/vms/:id', async (req, res) => {
    try {
      res.json(await vmService.getVMStatus(req.params.id));
    } catch (err: any) {
      console.error('[API] get VM failed:', err);
      res.status(404).json({
        error: err?.message || 'Virtual machine not found',
      });
    }
  });

  // Start VM
  app.post('/api/vms/:id/start', async (req, res) => {
    try {
      res.json(await vmService.startVM(req.params.id));
    } catch (err: any) {
      console.error('[API] start VM failed:', err);
      res.status(500).json({
        error: err?.message || 'Unable to start virtual machine',
      });
    }
  });

  // Stop VM
  app.post('/api/vms/:id/stop', async (req, res) => {
    try {
      res.json(await vmService.stopVM(req.params.id));
    } catch (err: any) {
      console.error('[API] stop VM failed:', err);
      res.status(500).json({
        error: err?.message || 'Unable to stop virtual machine',
      });
    }
  });

  // Restart VM
  app.post('/api/vms/:id/restart', async (req, res) => {
    try {
      res.json(await vmService.restartVM(req.params.id));
    } catch (err: any) {
      console.error('[API] restart VM failed:', err);
      res.status(500).json({
        error: err?.message || 'Unable to restart virtual machine',
      });
    }
  });

  // Delete VM
  app.delete('/api/vms/:id', async (req, res) => {
    try {
      await vmService.deleteVM(req.params.id);
      res.json({
        success: true,
        message: `VM ${req.params.id} deleted`,
      });
    } catch (err: any) {
      console.error('[API] delete VM failed:', err);
      res.status(500).json({
        error: err?.message || 'Unable to delete virtual machine',
      });
    }
  });

  // Live Screen Capture Frame
  app.get('/api/vms/:id/screen', async (req, res) => {
    try {
      const buffer = await vmService.captureScreen(req.params.id);

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader(
        'Cache-Control',
        'no-cache, no-store, must-revalidate'
      );
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      res.send(buffer);
    } catch (err: any) {
      console.error(
        `[Screen] Capture failed for VM ${req.params.id}:`,
        err?.stack || err?.message || err
      );

      res.status(503).json({
        error: err?.message || 'Screen capture is temporarily unavailable',
        vmId: req.params.id,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Dispatch Touch/Keyboard/Swipe Input
  app.post('/api/vms/:id/input', async (req, res) => {
    try {
      res.json(await vmService.sendInput(req.params.id, req.body));
    } catch (err: any) {
      console.error('[API] VM input failed:', err);
      res.status(400).json({
        error: err?.message || 'Unable to send input',
      });
    }
  });

  // Install APK
  app.post(
    '/api/vms/:id/install-apk',
    upload.single('apk'),
    async (req, res) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: 'No APK file uploaded' });
          return;
        }

        const result = await vmService.installApk(
          req.params.id,
          req.file.path,
          req.file.originalname
        );

        fs.unlink(req.file.path, () => {});
        res.json(result);
      } catch (err: any) {
        if (req.file) {
          fs.unlink(req.file.path, () => {});
        }

        console.error('[API] APK installation failed:', err);
        res.status(500).json({
          error: err?.message || 'Unable to install APK',
        });
      }
    }
  );

  // Push File to /sdcard/Download/
  app.post(
    '/api/vms/:id/push-file',
    upload.single('file'),
    async (req, res) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: 'No file uploaded' });
          return;
        }

        const result = await vmService.pushFile(
          req.params.id,
          req.file.path,
          req.file.originalname
        );

        fs.unlink(req.file.path, () => {});
        res.json(result);
      } catch (err: any) {
        if (req.file) {
          fs.unlink(req.file.path, () => {});
        }

        console.error('[API] File push failed:', err);
        res.status(500).json({
          error: err?.message || 'Unable to push file',
        });
      }
    }
  );

  // Fetch Serial and Logcat Logs
  app.get('/api/vms/:id/logs', async (req, res) => {
    try {
      const lines = parseInt(req.query.lines as string, 10) || 120;
      res.json(await vmService.getLogs(req.params.id, lines));
    } catch (err: any) {
      console.error('[API] VM logs failed:', err);
      res.status(500).json({
        error: err?.message || 'Unable to retrieve VM logs',
      });
    }
  });

  // List Installed Apps
  app.get('/api/vms/:id/apps', async (req, res) => {
    try {
      res.json({
        apps: await vmService.listInstalledApps(req.params.id),
      });
    } catch (err: any) {
      console.error('[API] list apps failed:', err);
      res.status(500).json({
        error: err?.message || 'Unable to list installed apps',
      });
    }
  });

  // Launch App
  app.post('/api/vms/:id/launch-app', async (req, res) => {
    try {
      const { packageName } = req.body;

      if (!packageName) {
        res.status(400).json({
          error: 'packageName is required',
        });
        return;
      }

      res.json(
        await vmService.launchApp(req.params.id, packageName)
      );
    } catch (err: any) {
      console.error('[API] launch app failed:', err);
      res.status(500).json({
        error: err?.message || 'Unable to launch app',
      });
    }
  });

  // Provisioning & asset preparation status
  app.get('/api/provisioning-status', (_req, res) => {
    try {
      res.json(assetManager.getProvisioningStatus());
    } catch (err: any) {
      console.error('[API] provisioning status failed:', err);
      res.status(500).json({
        error: err?.message || 'Unable to retrieve provisioning status',
      });
    }
  });

  // --- Vite Dev Server Middleware Integration ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });

    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));

    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  // --- Default VM Bootstrap ---
  // Run only one startup flow; do not race a timeout against asset preparation.
  let bootstrapStarted = false;

  const bootstrapDefaultVM = async () => {
    if (bootstrapStarted) return;
    bootstrapStarted = true;

    try {
      console.log('[Bootstrap] Preparing Android assets...');

      const ready = await assetManager.ensureAndroidAssetsReady();

      if (!ready) {
        const state = assetManager.getProvisioningStatus();

        console.error(
          '[Bootstrap] Android assets are not ready:',
          state.error || state.message
        );

        return;
      }

      const vms = await vmService.listVMs();

      if (vms.length === 0) {
        console.log('[Bootstrap] Creating default Moon Android VM...');
        await vmService.createVM(
          'Moon Pixel Pro (Default)',
          2048,
          2
        );
      } else {
        console.log(
          `[Bootstrap] Found ${vms.length} existing VM(s); ` +
          'skipping duplicate creation.'
        );
      }
    } catch (err: any) {
      console.error(
        '[Bootstrap] Startup failed:',
        err?.stack || err?.message || err
      );
    }
  };

  // Start listening immediately while provisioning runs in the background.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `Moon Studio Cloud Android server listening on port ${PORT}`
    );

    void bootstrapDefaultVM();
  });
}

startServer().catch((err) => {
  console.error('Fatal server boot error:', err);
  process.exit(1);
});
