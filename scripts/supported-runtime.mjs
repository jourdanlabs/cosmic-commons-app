// Copyright 2026 Leland Jourdan II / C&L Strategy
// SPDX-License-Identifier: Apache-2.0

/** Launch support contract (F0-B): major-version range, not receipt replay identity. */
export const SUPPORTED_LAUNCH_MAJOR = 24;
export const SUPPORTED_LAUNCH_MIN_MINOR = 15;
export const TESTED_LAUNCH_PATCHES = ['24.15.0', '24.18.0', '24.19.0'];

export function supportedLaunchRangeLabel() {
  return `Node ${SUPPORTED_LAUNCH_MAJOR}.${SUPPORTED_LAUNCH_MIN_MINOR}.x–${SUPPORTED_LAUNCH_MAJOR}.x (tested: ${TESTED_LAUNCH_PATCHES.join(', ')})`;
}

export function assertSupportedLaunchRuntime() {
  const parts = process.versions.node.split('.');
  const major = Number(parts[0]);
  const minor = Number(parts[1]);
  if (major !== SUPPORTED_LAUNCH_MAJOR || minor < SUPPORTED_LAUNCH_MIN_MINOR || Number.isNaN(minor)) {
    throw new Error(`COMMONS requires ${supportedLaunchRangeLabel()}. Current Node: ${process.versions.node}`);
  }
}
