/**

@license

SPDX-License-Identifier: Apache-2.0
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

private provisioningPromise: Promise<boolean> | null = null;

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

Resolves a writable storage directory.
*/
public getStorageDir(): string {
const custom = process.env.MOON_STORAGE_DIR;

if (custom) {

  fs.mkdirSync(custom, { recursive: true });
  return custom;
}

const defaultDir = path.join(os.tmpdir(), 'moon-vms');

try {
  fs.mkdirSync(defaultDir, { recursive: true });
  return defaultDir;
} catch (error) {
  const fallback = path.join(process.cwd(), '.data', 'moon-vms');
  fs.mkdirSync(fallback, { recursive: true });
  console.warn(
    '[AssetManager] Using fallback storage directory:',
    fallback,
    error,
  );
  return fallback;
}

}

public getImagesDir(): string {
const dir = path.join(this.getStorageDir(), 'images');
fs.mkdirSync(dir, { recursive: true });
return dir;
}

public getInstancesDir(): string {
const dir = path.join(this.getStorageDir(), 'instances');
fs.mkdirSync(dir, { recursive: true });
return dir;
}

public getProvisioningStatus(): ProvisioningStatus {
return { ...this.provisioningStatus };
}

private ensureStorageDirs(): void {
try {
this.getImagesDir();
this.getInstancesDir();
} catch (error) {
console.warn(
'[AssetManager] Failed to create storage directories:',
error,
);
}
}

/**

Checks whether all required files for a supported Android image exist.
*/
public checkAssetsReady(): boolean {
const imagesDir = this.getImagesDir();

const ax86Iso = path.join(imagesDir, 'android_x86.iso');

const ax86Kernel = path.join(imagesDir, 'kernel');
const ax86Initrd = path.join(imagesDir, 'initrd.img');
const ax86System = path.join(imagesDir, 'system.sfs');

const hasAx86 =
  this.isNonEmptyFile(ax86Iso) &&
  this.isNonEmptyFile(ax86Kernel) &&
  this.isNonEmptyFile(ax86Initrd) &&
  this.isNonEmptyFile(ax86System);

const systemImg = path.join(imagesDir, 'system.img');
const kernel = path.join(imagesDir, 'kernel-qemu');
const ramdisk = path.join(imagesDir, 'ramdisk_sda.img');

const hasAosp =
  this.isNonEmptyFile(systemImg) &&
  this.isNonEmptyFile(kernel) &&
  this.isNonEmptyFile(ramdisk);

const ready = hasAx86 || hasAosp;

this.provisioningStatus.isReady = ready;

if (ready) {
  this.provisioningStatus.message = 'Android OS assets are ready.';
  this.provisioningStatus.progress = 100;
  this.provisioningStatus.error = undefined;
}

return ready;

}

private isNonEmptyFile(filePath: string): boolean {
try {
return (
fs.existsSync(filePath) &&
fs.statSync(filePath).isFile() &&
fs.statSync(filePath).size > 0
);
} catch {
return false;
}
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
const ax86System = path.join(imagesDir, 'system.sfs');

if (
  this.isNonEmptyFile(ax86Iso) &&
  this.isNonEmptyFile(ax86Kernel) &&
  this.isNonEmptyFile(ax86Initrd) &&
  this.isNonEmptyFile(ax86System)
) {
  return {
    mode: 'android-x86',
    kernel: ax86Kernel,
    ramdisk: ax86Initrd,
    systemImg: ax86System,
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

Prevents concurrent requests from downloading/extracting the same image.
*/
public ensureAndroidAssetsReady(): Promise<boolean> {
if (this.checkAssetsReady()) {
return Promise.resolve(true);
}

if (this.provisioningPromise) {

  return this.provisioningPromise;
}

this.provisioningPromise = this.prepareAndroidAssets().finally(() => {
  this.provisioningStatus.isDownloading = false;
  this.provisioningPromise = null;
});

return this.provisioningPromise;

}

private async prepareAndroidAssets(): Promise<boolean> {
this.provisioningStatus.isDownloading = true;
this.provisioningStatus.isReady = false;
this.provisioningStatus.error = undefined;
this.provisioningStatus.progress = 5;
this.provisioningStatus.message =
'Preparing Android-x86 system image...';

const imagesDir = this.getImagesDir();
const isoPath = path.join(imagesDir, 'android_x86.iso');
const downloadPath = `${isoPath}.download`;

try {
  if (!this.isNonEmptyFile(isoPath)) {
    try {
      if (fs.existsSync(downloadPath)) {
        fs.rmSync(downloadPath, { force: true });
      }
    } catch {
      // Ignore cleanup errors; curl will report any actual write failure.
    }

    console.log(
      '[AssetManager] Downloading Android-x86 4.4 ISO...',
    );

    this.provisioningStatus.progress = 15;
    this.provisioningStatus.message =
      'Downloading Android-x86 ISO. This may take several minutes...';

    await execAsync(
      `curl -L -f --retry 2 --connect-timeout 20 --max-time 300 -o "${downloadPath}" "https://downloads.sourceforge.net/project/android-x86/Release%204.4/android-x86-4.4-r5.iso"`,
      {
        timeout: 320000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    if (!this.isNonEmptyFile(downloadPath)) {
      throw new Error(
        'The Android ISO download finished without a valid file.',
      );
    }

    const downloadSize = fs.statSync(downloadPath).size;

    if (downloadSize < 50 * 1024 * 1024) {
      throw new Error(
        `Downloaded ISO is unexpectedly small (${downloadSize} bytes).`,
      );
    }

    fs.renameSync(downloadPath, isoPath);
    console.log(
      `[AssetManager] ISO downloaded (${downloadSize} bytes).`,
    );
  }

  this.provisioningStatus.progress = 65;
  this.provisioningStatus.message =
    'Extracting Android kernel, initrd, and system image...';

  const requiredFiles = ['kernel', 'initrd.img', 'system.sfs'];

  const allFilesExist = () =>
    requiredFiles.every((name) =>
      this.isNonEmptyFile(path.join(imagesDir, name)),
    );

  if (!allFilesExist()) {
    console.log(
      '[AssetManager] Extracting Android image files from ISO...',
    );

    // First try 7-Zip.
    try {
      await execAsync(
        `7z e -y -o"${imagesDir}" "${isoPath}" kernel initrd.img system.sfs`,
        {
          timeout: 180000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );
    } catch (error) {
      console.warn(
        '[AssetManager] 7z extraction failed; trying bsdtar:',
        error,
      );
    }

    // If 7-Zip is unavailable or incomplete, try bsdtar.
    if (!allFilesExist()) {
      try {
        await execAsync(
          `bsdtar -xf "${isoPath}" -C "${imagesDir}" kernel initrd.img system.sfs`,
          {
            timeout: 180000,
            maxBuffer: 10 * 1024 * 1024,
          },
        );
      } catch (error) {
        console.warn(
          '[AssetManager] bsdtar extraction failed:',
          error,
        );
      }
    }

    if (!allFilesExist()) {
      const missing = requiredFiles.filter(
        (name) =>
          !this.isNonEmptyFile(path.join(imagesDir, name)),
      );

      throw new Error(
        `Android ISO extraction is incomplete. Missing or empty files: ${missing.join(', ')}. Ensure 7z or bsdtar is installed and the ISO contains these files.`,
      );
    }
  }

  this.provisioningStatus.progress = 95;
  this.provisioningStatus.message =
    'Verifying Android system assets...';

  if (!this.checkAssetsReady()) {
    throw new Error(
      'Android asset verification failed after extraction.',
    );
  }

  this.provisioningStatus.progress = 100;
  this.provisioningStatus.isReady = true;
  this.provisioningStatus.message =
    'Android OS assets are ready.';

  console.log(
    '[AssetManager] Android OS assets verified successfully.',
  );

  return true;
} catch (error: any) {
  const message =
    error instanceof Error ? error.message : String(error);

  console.error(
    '[AssetManager] Failed to prepare Android assets:',
    message,
  );

  this.provisioningStatus.isReady = false;
  this.provisioningStatus.error = message;
  this.provisioningStatus.message =
    `Android asset preparation failed: ${message}`;

  try {
    if (fs.existsSync(downloadPath)) {
      fs.rmSync(downloadPath, { force: true });
    }
  } catch {
    // Ignore temporary-file cleanup errors.
  }

  return false;
}

}

private async buildVirtIORamdisk(
srcRamdisk: string,
targetVirtIO: string,
): Promise<void> {
const tmpBuild = path.join(
os.tmpdir(),
rd_build_${Date.now()},
);

try {
  if (!fs.existsSync(srcRamdisk)) {
    console.warn(
      '[AssetManager] Source ramdisk does not exist:',
      srcRamdisk,
    );
    return;
  }

  fs.mkdirSync(tmpBuild, { recursive: true });

  await execAsync(
    `cd "${tmpBuild}" && zcat "${srcRamdisk}" | cpio -idmv >/dev/null && ` +
      `echo "service.adb.tcp.port=5555" >> default.prop && ` +
      `sed -i 's|/dev/block/mtdblock0|/dev/block/vda|g' fstab.goldfish 2>/dev/null || true && ` +
      `sed -i 's|/dev/block/mtdblock1|/dev/block/vdc|g' fstab.goldfish 2>/dev/null || true && ` +
      `sed -i 's|/dev/block/mtdblock2|/dev/block/vdb|g' fstab.goldfish 2>/dev/null || true && ` +
      `find . | cpio -o -H newc | gzip -9 > "${targetVirtIO}"`,
    {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
} catch (error: any) {
  console.warn(
    '[AssetManager] Notice during ramdisk patch:',
    error?.message ?? error,
  );

  if (
    !fs.existsSync(targetVirtIO) &&
    fs.existsSync(srcRamdisk)
  ) {
    fs.copyFileSync(srcRamdisk, targetVirtIO);
  }
} finally {
  try {
    if (fs.existsSync(tmpBuild)) {
      fs.rmSync(tmpBuild, {
        recursive: true,
        force: true,
      });
    }
  } catch {
    // Ignore temporary-directory cleanup errors.
  }
}

}
}

export const assetManager = AssetManager.getInstance();
