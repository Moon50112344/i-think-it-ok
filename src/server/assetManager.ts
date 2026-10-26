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
