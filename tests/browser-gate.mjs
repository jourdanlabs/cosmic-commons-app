// Copyright 2026 Leland Jourdan II / JourdanLabs
// SPDX-License-Identifier: Apache-2.0
// Optional production-browser gate. No browser dependency is required to start
// COMMONS or run its ordinary native Node test suite.
// COMMONS_BROWSER_MODULES=/path/to/browser-tools node tests/browser-gate.mjs
// That tools directory needs playwright and an installed Chromium, or
// @sparticuz/chromium. This gate uses only its own temporary synthetic workspace.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createApplication } from '../server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const moduleRoot = process.env.COMMONS_BROWSER_MODULES;
if (!moduleRoot) throw new Error('Set COMMONS_BROWSER_MODULES to your optional browser tools directory. This script is not part of npm test.');
const require = createRequire(path.join(path.resolve(moduleRoot), 'package.json'));
let playwright;
try { playwright = await import(pathToFileURL(require.resolve('playwright')).href); }
catch {
  const primary = process.env.COMMONS_PLAYWRIGHT_MODULE || '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
  playwright = await import(pathToFileURL(primary).href);
}
const { chromium } = playwright.default ?? playwright;
const directory = await mkdtemp(path.join(tmpdir(), 'commons-browser-'));
const screenshotDirectory = path.join(root, 'evidence/screenshots');
await mkdir(screenshotDirectory, { recursive: true });
const app = await createApplication({ dataDir: path.join(directory, 'data'), port: 0 });
const records = [], pageErrors = [], externalRequests = [];
let browser, page, activeGate;
const startedAt = new Date().toISOString();

async function gate(name, fn) {
  activeGate = name;
  const start = performance.now();
  await fn();
  records.push({ name, status: 'PASS', durationMs: Math.round(performance.now() - start) });
  console.log('PASS ' + name);
}

const exact = text => new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
function labeled(scope, label, control = 'input,select,textarea') {
  return scope.locator('label').filter({ has: page.locator('.field-label').filter({ hasText: exact(label) }) }).locator(control).first();
}
async function fillField(scope, label, value, control = 'input,textarea') {
  const locator = labeled(scope, label, control);
  await locator.fill(value);
  await locator.press('Tab');
  return locator;
}
async function saveNow() {
  await page.getByRole('button', { name: 'Save now', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('save-status')?.textContent.startsWith('Saved · revision'));
}
async function snapshot(name) {
  await page.screenshot({ path: path.join(screenshotDirectory, name + '.png'), fullPage: true });
}
async function navigate(name) {
  await page.locator('.workspace-nav').getByRole('link', { name, exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#view > .loading-message'));
}
async function createBlank(title, kind = 'policy') {
  await navigate('Cases');
  await page.getByRole('button', { name: 'New case', exact: true }).click();
  const modal = page.locator('#modal');
  await fillField(modal, 'Title', title);
  await labeled(modal, 'Case type', 'select').selectOption(kind);
  await fillField(modal, 'Question', kind === 'policy' ? 'Does the supplied quality record satisfy our declared threshold?' : 'Which of our two declared hypotheses better fits the observations?');
  await modal.getByRole('button', { name: 'Create case', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#case/') && document.getElementById('case-title'));
  return page.url().split('#case/')[1];
}
async function inputTab() {
  await page.getByRole('button', { name: 'Inputs', exact: true }).click();
  await page.locator('#guided-inputs').waitFor({ state: 'visible' });
}
async function run() {
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/run') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Run reasoning', exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200, await response.text());
  const result = await response.json();
  await page.locator('#run-current').waitFor({ state: 'visible' });
  return result.run;
}
async function downloadLink(name, savedName) {
  const promise = page.waitForEvent('download');
  await page.getByRole('link', { name, exact: true }).click();
  const download = await promise;
  assert.equal(await download.failure(), null);
  const filename = path.join(directory, savedName);
  await download.saveAs(filename);
  return filename;
}
async function savedCase(caseId) {
  return page.evaluate(async caseId => {
    const response = await fetch('/api/cases/' + encodeURIComponent(caseId));
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }, caseId);
}

let policyId, policyAllow, policyDeny, policyDeferred, investigationId, investigationRun, exportPath, backupPath;
try {
  let launch = { headless: true };
  if (process.env.COMMONS_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.COMMONS_CHROMIUM_EXECUTABLE;
  else {
    let sparticuz;
    try { sparticuz = await import(pathToFileURL(require.resolve('@sparticuz/chromium')).href); }
    catch { /* A normal Playwright-managed browser may be installed instead. */ }
    if (sparticuz) {
      const runtime = sparticuz.default ?? sparticuz;
      // Sparticuz defaults disable web security for serverless rendering. A
      // production security gate must retain normal browser Origin/CORS behavior.
      launch = { headless: true, executablePath: await runtime.executablePath(), args: runtime.args.filter(arg => !['--disable-web-security', '--allow-running-insecure-content'].includes(arg)) };
    }
  }
  browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.route('**/*', route => {
    if (route.request().url().startsWith(app.url + '/')) return route.continue();
    externalRequests.push(route.request().url()); return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => pageErrors.push(error.message));

  await gate('production shell opens with attribution and no cloud dependency', async () => {
    await page.goto(app.url);
    await page.getByRole('heading', { name: 'Your cases', exact: true }).waitFor();
    assert.match(await page.locator('footer').innerText(), /Leland.*TJ.*Jourdan II/);
    await snapshot('01-cases-desktop');
  });

  await gate('blank guided Decide case creates evidence, typed fact and requirement with ALLOW', async () => {
    policyId = await createBlank('A real question · browser gate');
    await inputTab();
    await page.getByRole('button', { name: 'Use current time', exact: true }).click();
    await page.getByRole('button', { name: 'Add source record', exact: true }).click();
    const source = page.locator('[data-record-kind="source"]').first();
    await fillField(source, 'Source text', 'The supplied synthetic quality record says 85.');
    await page.getByRole('button', { name: 'Add fact', exact: true }).click();
    const fact = page.locator('[data-record-kind="fact"]').first();
    await labeled(fact, 'Value type', 'select').selectOption('number');
    await fillField(fact, 'Fact value', '85', 'textarea');
    await page.waitForFunction(() => !document.querySelector('[data-record-kind="fact"] textarea:invalid'));
    await page.getByRole('button', { name: 'Add requirement', exact: true }).click();
    const rule = page.locator('[data-record-kind="rule"]').first();
    await labeled(rule, 'Requirement operator', 'select').selectOption('gte');
    await fillField(rule, 'Numeric threshold', '80', 'textarea');
    await page.waitForFunction(() => !document.querySelector('[data-record-kind="rule"] textarea:invalid'));
    await saveNow();
    await snapshot('02-decide-guided-desktop');
    policyAllow = await run();
    assert.equal(policyAllow.result.verdict, 'ALLOW');
    await page.getByText('ALLOW', { exact: true }).waitFor();
    await snapshot('03-decide-allow-desktop');
    assert.equal((await savedCase(policyId)).case.input.evidence.facts[0].value, 85);
  });

  await gate('source upload creates a committed file record and retained source trace', async () => {
    await inputTab();
    await labeled(page.locator('#guided-inputs'), 'Upload supporting file', 'input[type=file]').setInputFiles({ name: 'quality-record.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic quality record: 85\n') });
    await page.getByRole('link', { name: 'Download quality-record.txt', exact: true }).waitFor();
    const detail = await savedCase(policyId);
    assert.equal(detail.case.attachments.length, 1);
    assert.equal(detail.case.input.evidence.sources.length, 2);
    assert.equal(detail.case.latestRun.current, false);
    policyAllow = await run();
    assert.equal(policyAllow.result.verdict, 'ALLOW');
  });

  await gate('invalid numeric form draft stays visible and cannot run the prior hidden typed value', async () => {
    await inputTab();
    const fact = page.locator('[data-record-kind="fact"]').first();
    for (const invalid of ['9007199254740993', '0.10000000000000001']) {
      const value = await fillField(fact, 'Fact value', invalid, 'textarea');
      await fact.getByText(/roundtrippable|safe range/i).first().waitFor();
      let requests = 0;
      const countRunRequests = request => { if (request.url().endsWith('/run') && request.method() === 'POST') requests++; };
      page.on('request', countRunRequests);
      await page.getByRole('button', { name: 'Run reasoning', exact: true }).click();
      await page.getByText('Resolve the highlighted values before running.', { exact: true }).waitFor();
      page.off('request', countRunRequests);
      assert.equal(requests, 0, 'invalid draft never requests an engine run');
      assert.equal(await value.inputValue(), invalid, 'invalid user draft stays available for correction');
      assert.equal((await savedCase(policyId)).case.input.evidence.facts[0].value, 85);
      await snapshot('03b-invalid-numeric-draft');
      await fillField(fact, 'Fact value', '85', 'textarea');
      await page.waitForFunction(() => !document.querySelector('[data-record-kind="fact"] textarea:invalid'));
    }
    await saveNow();
  });

  await gate('changing evidence marks old result stale and evaluates DENY', async () => {
    await inputTab();
    const fact = page.locator('[data-record-kind="fact"]').first();
    await fillField(fact, 'Fact value', '79', 'textarea');
    await page.waitForFunction(() => !document.querySelector('[data-record-kind="fact"] textarea:invalid'));
    await saveNow();
    await page.getByRole('button', { name: 'Results', exact: true }).click();
    assert.equal(await page.locator('#run-current').innerText(), 'PREVIOUS REVISION');
    policyDeny = await run();
    assert.equal(policyDeny.result.verdict, 'DENY');
    await snapshot('04-decide-deny-desktop');
  });

  await gate('receipt download and actual browser upload replay with a retained anchor', async () => {
    const receiptPath = await downloadLink('Download exact receipt', 'denied.receipt.json');
    assert.equal(await readFile(receiptPath, 'utf8'), policyDeny.receiptText);
    await page.getByRole('button', { name: 'Verify this receipt', exact: true }).click();
    await page.getByLabel('Raw receipt JSON', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Raw receipt JSON', { exact: true }).inputValue(), policyDeny.receiptText, 'case verifier carries exact queued receipt text');
    await page.getByLabel('Upload raw receipt', { exact: true }).setInputFiles(receiptPath);
    await page.waitForFunction(raw => document.querySelector('[aria-label="Raw receipt JSON"]')?.value === raw, policyDeny.receiptText);
    assert.equal(await page.getByLabel('Raw receipt JSON', { exact: true }).inputValue(), policyDeny.receiptText);
    await page.getByLabel('Independently trusted digest', { exact: true }).fill(policyDeny.digest);
    await page.getByRole('button', { name: 'Verify & replay', exact: true }).click();
    await page.getByText('CHECKS PASSED', { exact: true }).waitFor();
    await snapshot('05-receipt-anchored-desktop');
    await page.getByLabel('Independently trusted digest', { exact: true }).fill('');
    await page.getByRole('button', { name: 'Verify & replay', exact: true }).click();
    await page.locator('.verification-output').getByText('UNANCHORED', { exact: true }).first().waitFor();
    await page.getByLabel('Independently trusted digest', { exact: true }).fill('0'.repeat(64));
    await page.getByRole('button', { name: 'Verify & replay', exact: true }).click();
    await page.locator('.verification-output').getByText('CHECKS FAILED', { exact: true }).waitFor();
    await page.locator('.verification-checks').getByText('MISMATCH', { exact: true }).waitFor();
  });

  await gate('false first duplicate verdict reaches server raw and is refused through file upload', async () => {
    const attack = policyDeny.receiptText.replace(/"verdict"\s*:\s*"DENY"/, '"v\\u0065rdict":"ALLOW","verdict":"DENY"');
    assert.notEqual(attack, policyDeny.receiptText);
    await page.getByLabel('Upload raw receipt', { exact: true }).setInputFiles({ name: 'duplicate-attack.json', mimeType: 'application/json', buffer: Buffer.from(attack) });
    await page.waitForFunction(raw => document.querySelector('[aria-label="Raw receipt JSON"]')?.value === raw, attack);
    assert.equal(await page.getByLabel('Raw receipt JSON', { exact: true }).inputValue(), attack);
    await page.getByLabel('Independently trusted digest', { exact: true }).fill(policyDeny.digest);
    const requestPromise = page.waitForRequest(request => request.url().includes('/api/verify') && request.method() === 'POST');
    await page.getByRole('button', { name: 'Verify & replay', exact: true }).click();
    assert.equal((await requestPromise).postData(), attack, 'browser did not parse and collapse duplicate keys');
    await page.locator('.verification-output').getByText(/duplicate/i).first().waitFor();
    assert.equal(await page.locator('.verification-output').getByText('CHECKS PASSED', { exact: true }).count(), 0);
    await snapshot('06-receipt-duplicate-refused');
  });

  await gate('missing required evidence is prominent DEFER and historical results survive refresh', async () => {
    await page.goto(app.url + '#case/' + policyId);
    await inputTab();
    await page.getByRole('button', { name: 'Remove fact', exact: true }).click();
    await saveNow();
    policyDeferred = await run();
    assert.equal(policyDeferred.result.verdict, 'DEFER');
    await page.locator('.summary-cards').getByText('DEFER', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'History', exact: true }).click();
    assert.equal(await page.locator('.run-row').count(), 4);
    await page.reload();
    await page.getByRole('button', { name: 'History', exact: true }).click();
    assert.equal(await page.locator('.run-row').count(), 4);
    const detail = await savedCase(policyId);
    assert.equal(detail.runs.find(run => run.id === policyDeny.id).receiptText, policyDeny.receiptText);
    await snapshot('07-history-desktop');
  });

  await gate('blank guided Investigate records explicit model, action losses and ordered observations', async () => {
    investigationId = await createBlank('My declared investigation · browser gate', 'discovery');
    await inputTab();
    await page.getByLabel('Total budget', { exact: true }).fill('6');
    await page.getByLabel('Total budget', { exact: true }).press('Tab');
    await page.waitForFunction(() => !document.querySelector('[aria-label="Total budget"]:invalid'));
    await labeled(page.locator('#guided-inputs'), 'Include declared actions', 'input[type=checkbox]').check();
    await page.getByRole('button', { name: 'Add action', exact: true }).click();
    await page.getByLabel('Loss for action-1 under hypothesis-a', { exact: true }).fill('1');
    await page.getByLabel('Loss for action-1 under hypothesis-a', { exact: true }).press('Tab');
    await page.getByLabel('Loss for action-1 under hypothesis-b', { exact: true }).fill('1');
    await page.getByLabel('Loss for action-1 under hypothesis-b', { exact: true }).press('Tab');
    await page.waitForFunction(() => !document.querySelector('#guided-inputs input:invalid'));
    await saveNow();
    await page.getByLabel('New observed outcome', { exact: true }).selectOption('positive');
    await page.getByRole('button', { name: 'Add observation', exact: true }).click();
    await saveNow();
    await page.getByLabel('New observed outcome', { exact: true }).selectOption('positive');
    await page.getByRole('button', { name: 'Add observation', exact: true }).click();
    await saveNow();
    assert.equal(await page.getByLabel('Total budget', { exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('Outcome for observation 1', { exact: true }).isDisabled(), true);
    await snapshot('08-investigate-guided-desktop');
    investigationRun = await run();
    assert.ok(Math.abs(investigationRun.result.snapshot.posterior['hypothesis-a'] - 16 / 17) < 1e-14);
    assert.equal(investigationRun.result.snapshot.remainingBudget, 4);
    assert.equal(investigationRun.result.decisionStatus, 'AVAILABLE');
    assert.equal(investigationRun.result.action.actionId, 'action-1');
    await snapshot('09-investigate-result-desktop');
  });

  await gate('fresh investigation fork preserves original observed case and opens a zero-observation epoch', async () => {
    const original = await savedCase(investigationId);
    await inputTab();
    await page.getByRole('button', { name: 'Fork a fresh investigation', exact: true }).click();
    await page.locator('#modal').getByRole('button', { name: 'Create fork', exact: true }).click();
    await page.waitForFunction(originalId => location.hash.startsWith('#case/') && !location.hash.endsWith(originalId) && document.getElementById('case-title'), investigationId);
    const forkId = page.url().split('#case/')[1];
    const fork = await savedCase(forkId);
    assert.deepEqual(fork.case.input.observations, []);
    assert.notEqual(fork.case.input.adequacy.epochId, original.case.input.adequacy.epochId);
    assert.equal((await savedCase(investigationId)).case.input.observations.length, 2);
  });

  await gate('rejected family template displays DEFER without an action and works on a narrow screen', async () => {
    await navigate('Templates');
    const template = page.locator('.template-card').filter({ has: page.getByRole('heading', { name: 'Rejected model family', exact: true }) });
    await template.getByRole('button', { name: 'Use template', exact: true }).click();
    await page.locator('#modal').getByRole('button', { name: 'Create case', exact: true }).click();
    await page.getByRole('button', { name: 'Run reasoning', exact: true }).waitFor();
    const deferred = await run();
    assert.equal(deferred.result.decisionStatus, 'DEFER');
    assert.equal(deferred.result.action, null);
    await page.getByText('DEFER — no action suggestion', { exact: true }).waitFor();
    await snapshot('10-investigate-defer-desktop');
    await page.setViewportSize({ width: 390, height: 844 });
    await snapshot('11-investigate-defer-mobile');
    await inputTab();
    await page.getByRole('button', { name: 'Run reasoning', exact: true }).waitFor();
    await snapshot('12-investigate-inputs-mobile');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2), false, 'page does not overflow its narrow viewport');
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  await gate('complete case export and browser import retain history and attachments', async () => {
    await page.goto(app.url + '#case/' + policyId);
    await page.getByText('Case actions', { exact: true }).click();
    exportPath = await downloadLink('Export complete case', 'exported.commons');
    await navigate('Cases');
    await page.getByLabel('Import case', { exact: true }).setInputFiles(exportPath);
    await page.waitForFunction(originalId => location.hash.startsWith('#case/') && !location.hash.endsWith(originalId) && document.getElementById('case-title'), policyId);
    const importedId = page.url().split('#case/')[1];
    const imported = await savedCase(importedId);
    assert.equal(imported.case.attachments.length, 1);
    assert.equal(imported.runs.length, 4);
    assert.equal(imported.runs.find(run => run.digest === policyDeny.digest).receiptText, policyDeny.receiptText);
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await snapshot('13-imported-history-desktop');
  });

  await gate('workspace backup and confirmed restore recover saved cases through the browser', async () => {
    await navigate('Settings');
    backupPath = await downloadLink('Download full workspace backup', 'workspace.commons-backup');
    const before = await page.evaluate(async () => (await (await fetch('/api/cases')).json()).cases.length);
    await createBlank('This case exists only after the backup');
    await navigate('Settings');
    await page.getByLabel('Choose workspace backup', { exact: true }).setInputFiles(backupPath);
    await page.getByRole('button', { name: 'Validate and restore workspace', exact: true }).click();
    await fillField(page.locator('#modal'), 'Confirmation', 'RESTORE');
    await page.locator('#modal').getByRole('button', { name: 'Restore backup', exact: true }).click();
    await page.getByText('Workspace restored after complete validation.', { exact: true }).waitFor();
    await navigate('Cases');
    const cases = await page.evaluate(async () => (await (await fetch('/api/cases')).json()).cases);
    assert.equal(cases.length, before);
    assert.equal(cases.some(record => record.title === 'This case exists only after the backup'), false);
    await snapshot('14-restored-cases-desktop');
  });

  await gate('all workflows remain free of uncaught browser exceptions and external requests', async () => {
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);
  });

  await writeFile(path.join(root, 'evidence/browser-gate.json'), JSON.stringify({ status: 'PASS', startedAt, finishedAt: new Date().toISOString(), runtime: { node: process.versions.node, platform: process.platform, arch: process.arch }, browser: await browser.version(), gates: records, pageErrors, externalRequests, screenshots: screenshotDirectory }, null, 2) + '\n');
  console.log(`${records.length}/${records.length} browser workflow gates passed.`);
} catch (error) {
  if (page) await snapshot('browser-gate-failure').catch(() => {});
  await writeFile(path.join(root, 'evidence/browser-gate.json'), JSON.stringify({ status: 'FAIL', activeGate, startedAt, finishedAt: new Date().toISOString(), runtime: { node: process.versions.node, platform: process.platform, arch: process.arch }, gates: records, error: error.stack, pageErrors, externalRequests }, null, 2) + '\n');
  throw error;
} finally {
  await browser?.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
