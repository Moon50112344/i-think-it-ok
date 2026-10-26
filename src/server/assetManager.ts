/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface ProvisioningStatus {
  isReady: boolean;
  isDownloading: boolean;
  progress: number;
  message: string;
  error?: string;
}

export class AssetManager {
  private static instance: AssetManager;
  private provisioningStatus: ProvisioningStatus = {
    isReady: false,
    isDownloading: false,
    progress: 0,
    message: 'Checking Android system assets...',
  };

  private constructor() {
    this.ensureStorageDirs();
    this.checkAssetsReady();
  }

  public static getInstance(): AssetManager {
    if (!AssetManager.instance) {
      AssetManager.instance = new AssetManager();
    }
    return AssetManager.instance;
  }

  /**
   * Safely resolves the VM storage root directory.
   * Uses os.tmpdir()/moon-vms which is world-writable (mode 1777), preventing EACCES on Render.
   */
  public getStorageDir(): string {
    if (process.env.MOON_STORAGE_DIR) {
      const custom = process.env.MOON_STORAGE_DIR;
      if (!fs.existsSync(custom)) {
        try { fs.mkdirSync(custom, { recursive: true }); } catch {}
      }
      return custom;
    }

    const defaultDir = path.join(os.tmpdir(), 'moon-vms');
    if (!fs.existsSync(defaultDir)) {
      try {
        fs.mkdirSync(defaultDir, { recursive: true });
      } catch {
        const fallback = path.join(process.cwd(), '.data', 'moon-vms');
        if (!fs.existsSync(fallback)) {
          fs.mkdirSync(fallback, { recursive: true });
        }
        return fallback;
      }
    }
    return defaultDir;
  }

  public getImagesDir(): string {
    const dir = path.join(this.getStorageDir(), 'images');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  public getInstancesDir(): string {
    const dir = path.join(this.getStorageDir(), 'instances');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  public getProvisioningStatus(): ProvisioningStatus {
    return { ...this.provisioningStatus };
  }

  private ensureStorageDirs(): void {
    try {
      this.getImagesDir();
      this.getInstancesDir();
    } catch (e: any) {
      console.warn('[AssetManager] Failed to create storage directories:', e.message);
    }
  }

  /**
   * Checks if all required Android x86 assets exist on disk.
   */
  public checkAssetsReady(): boolean {
    const imagesDir = this.getImagesDir();
    // Mode 1: Android-x86 (Hardware VESA GUI / Launcher)
    const ax86Iso = path.join(imagesDir, 'android_x86.iso');
    const ax86Kernel = path.join(imagesDir, 'kernel');
    const ax86Initrd = path.join(imagesDir, 'initrd.img');
    const hasAx86 = fs.existsSync(ax86Iso) && fs.existsSync(ax86Kernel) && fs.existsSync(ax86Initrd);

    // Mode 2: AOSP Goldfish
    const systemImg = path.join(imagesDir, 'system.img');
    const kernel = path.join(imagesDir, 'kernel-qemu');
    const ramdisk = path.join(imagesDir, 'ramdisk_sda.img');
    const hasAosp = fs.existsSync(systemImg) && fs.existsSync(kernel) && fs.existsSync(ramdisk);

    const ready = hasAx86 || hasAosp;
    this.provisioningStatus.isReady = ready;
    if (ready) {
      this.provisioningStatus.message = 'Android OS assets are ready.';
      this.provisioningStatus.progress = 100;
    }
    return ready;
  }

  public getAssets(): {
    mode: 'android-x86' | 'aosp';
    kernel: string;
    ramdisk: string;
    systemImg: string;
    isoPath?: string;
  } {
    const imagesDir = this.getImagesDir();
    const ax86Iso = path.join(imagesDir, 'android_x86.iso');
    const ax86Kernel = path.join(imagesDir, 'kernel');
    const ax86Initrd = path.join(imagesDir, 'initrd.img');

    if (fs.existsSync(ax86Iso) && fs.existsSync(ax86Kernel) && fs.existsSync(ax86Initrd)) {
      return {
        mode: 'android-x86',
        kernel: ax86Kernel,
        ramdisk: ax86Initrd,
        systemImg: path.join(imagesDir, 'system.sfs'),
        isoPath: ax86Iso,
      };
    }

    return {
      mode: 'aosp',
      kernel: path.join(imagesDir, 'kernel-qemu'),
      ramdisk: path.join(imagesDir, 'ramdisk_sda.img'),
      systemImg: path.join(imagesDir, 'system.img'),
    };
  }

  /**
   * Downloads official Google Android AOSP x86 system images on Render or fresh environments.
   */
  public async ensureAndroidAssetsReady(): Promise<boolean> {
    if (this.checkAssetsReady()) {
      return true;
    }

    if (this.provisioningStatus.isDownloading) {
      return new Promise((resolve) => {
        const interval = setInterval(() => {
          if (!this.provisioningStatus.isDownloading) {
            clearInterval(interval);
            resolve(this.provisioningStatus.isReady);
          }
        }, 1000);
      });
    }

    this.provisioningStatus.isDownloading = true;
    this.provisioningStatus.progress = 10;
    this.provisioningStatus.message = 'Downloading Android OS image (Android-x86 VESA GUI)...';

    const imagesDir = this.getImagesDir();
    const isoPath = path.join(imagesDir, 'android_x86.iso');

    try {
      if (!fs.existsSync(isoPath)) {
        console.log('[AssetManager] Downloading Android-x86 4.4 ISO (441 MB)...');
        this.provisioningStatus.progress = 25;
        this.provisioningStatus.message = 'Fetching Android OS ISO (441 MB)...';

        await execAsync(
          `curl -L -f -s -o "${isoPath}" "https://downloads.sourceforge.net/project/android-x86/Release%204.4/android-x86-4.4-r5.iso"`,
          { timeout: 300000 }
        );
      }

      this.provisioningStatus.progress = 70;
      this.provisioningStatus.message = 'Extracting kernel, initrd, and system.sfs...';
      console.log('[AssetManager] Extracting Android image files from ISO...');

      // Extract kernel, initrd.img, and system.sfs
      await execAsync(`7z e "${isoPath}" kernel initrd.img system.sfs -o"${imagesDir}" -y 2>/dev/null || bsdtar -xf "${isoPath}" kernel initrd.img system.sfs -C "${imagesDir}" 2>/dev/null || true`);

      this.provisioningStatus.progress = 100;
      this.provisioningStatus.isReady = this.checkAssetsReady();
      this.provisioningStatus.message = 'Android OS assets prepared successfully.';
      console.log('[AssetManager] Android OS assets prepared successfully.');
      return this.provisioningStatus.isReady;
    } catch (err: any) {
      console.error('[AssetManager] Failed to prepare Android assets:', err.message);
      this.provisioningStatus.error = err.message;
      this.provisioningStatus.message = `Asset preparation failed: ${err.message}`;
      return false;
    } finally {
      this.provisioningStatus.isDownloading = false;
    }
  }

  private async buildVirtIORamdisk(srcRamdisk: string, targetVirtIO: string): Promise<void> {
    const tmpBuild = path.join(os.tmpdir(), `rd_build_${Date.now()}`);
    try {
      if (!fs.existsSync(srcRamdisk)) return;
      fs.mkdirSync(tmpBuild, { recursive: true });

      await execAsync(
        `cd "${tmpBuild}" && zcat "${srcRamdisk}" | cpio -idmv >/dev/null && ` +
        `echo "service.adb.tcp.port=5555" >> default.prop && ` +
        `sed -i 's|/dev/block/mtdblock0|/dev/block/vda|g' fstab.goldfish 2>/dev/null || true && ` +
        `sed -i 's|/dev/block/mtdblock1|/dev/block/vdc|g' fstab.goldfish 2>/dev/null || true && ` +
        `sed -i 's|/dev/block/mtdblock2|/dev/block/vdb|g' fstab.goldfish 2>/dev/null || true && ` +
        `find . | cpio -o -H newc | gzip -9 > "${targetVirtIO}"`
      );
    } catch (e: any) {
      console.warn('[AssetManager] Notice during ramdisk patch:', e.message);
      // Fallback: if cpio patch fails, copy raw ramdisk
      if (!fs.existsSync(targetVirtIO) && fs.existsSync(srcRamdisk)) {
        fs.copyFileSync(srcRamdisk, targetVirtIO);
      }
    } finally {
      try {
        if (fs.existsSync(tmpBuild)) fs.rmSync(tmpBuild, { recursive: true, force: true });
      } catch {}
    }
  }
}

export const assetManager = AssetManager.getInstance();
