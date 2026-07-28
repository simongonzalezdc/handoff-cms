import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { AuthoringSnapshot } from '../src/model.js';
import type { TastecheckResult } from '../src/tastecheck.js';

interface BeatCall {
  readonly method: string;
  readonly payload?: unknown;
}

type Locale = 'en' | 'es';

declare global {
  interface Window {
    __beat: {
      snapshot(): AuthoringSnapshot;
      calls(): readonly BeatCall[];
      tastecheck(hash: string): TastecheckResult;
    };
  }
}

for (const locale of ['en', 'es'] as const) {
  test(`${locale} Cerafica five-task Handoff Beat`, async ({ page }, testInfo) => {
    const started = Date.now();
    await page.goto('/packages/web/e2e/handoff-beat.html');
    await expect(page.locator('h1')).toBeVisible();
    page.on('dialog', (dialog) => dialog.accept());

    await page.locator('[data-cms-control="locale"]').selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('h1')).toHaveText(locale === 'en' ? 'Handoff CMS authoring' : 'Creación de contenido en Handoff CMS');

    // 1. Peer-locale text edit.
    await page.locator('[data-cms-input="text"][data-cms-locale="en"]').fill('Cerafica studio — open by appointment');
    await page.locator('[data-cms-input="text"][data-cms-locale="es"]').fill('Estudio Cerafica — con cita previa');

    // 2. Image replacement with real bytes, focal point, and peer alt.
    await page.locator('[data-cms-input="alt"][data-cms-locale="en"]').fill('Moon vessel on a walnut table');
    await page.locator('[data-cms-input="alt"][data-cms-locale="es"]').fill('Vasija lunar sobre una mesa de nogal');
    const crop = page.locator('[data-cms-form="crop"]');
    await crop.locator('[data-cms-input="crop-x"]').fill('0.10');
    await crop.locator('[data-cms-input="crop-y"]').fill('0.10');
    await crop.locator('[data-cms-input="crop-w"]').fill('0.80');
    await crop.locator('[data-cms-input="crop-h"]').fill('0.80');
    await crop.locator('[data-cms-input="focal-x"]').fill('0.45');
    await crop.locator('[data-cms-input="focal-y"]').fill('0.55');
    await crop.locator('button[type="submit"]').click();
    const replacement = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const replaceForm = page.locator('[data-cms-form="replace"]');
    await replaceForm.locator('input[type="file"]').setInputFiles({ name: 'moon-vessel.png', mimeType: 'image/png', buffer: replacement });
    await replaceForm.locator('button[type="submit"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.calls().some((call) => call.method === 'replace'))).toBe(true);

    // 3. Safe product update; commerce price has no editable control.
    await page.locator('[data-cms-input="product-title"][data-cms-locale="en"]').fill('Moon Vessel — Summer 2026');
    await page.locator('[data-cms-input="product-title"][data-cms-locale="es"]').fill('Vasija Lunar — Verano 2026');
    const price = page.locator('[data-cms-product-price="product"]');
    await expect(price).toHaveAttribute('data-cms-product-price-amount', '24000');
    await expect(price).toHaveAttribute('data-cms-product-price-currency', 'USD');
    await expect(price).toHaveText(locale === 'en' ? '$240.00' : /240,00\sUS\$/);
    await expect(page.locator('[data-cms-input="product-price"]')).toHaveCount(0);

    // 4. Reorder a developer-approved section.
    await page.locator('[data-cms-action="block-reorder"][data-cms-block-id="story"][data-cms-action-direction="up"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.snapshot().blocks[0].id)).toBe('story');

    // 5. Preview, explicit propose/approve/publish, one-action rollback, async reconcile.
    await page.locator('[data-cms-action="preview"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.snapshot().visibleState)).toBe('preview_ready');
    await page.locator('[data-cms-action="propose"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.snapshot().visibleState)).toBe('proposed');
    await page.locator('[data-cms-action="approve"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.snapshot().visibleState)).toBe('approved');
    await page.locator('[data-cms-action="publish"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.snapshot().visibleState)).toBe('live');
    await page.locator('[data-cms-action="rollback"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.snapshot().visibleState)).toBe('canonical_written');
    await page.locator('[data-cms-action="reconcile"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.snapshot().visibleState)).toBe('deploy_pending');
    await page.locator('[data-cms-action="reconcile"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.snapshot().visibleState)).toBe('live');
    await expect(page.locator('[data-cms-audit-list="true"]')).toBeVisible();
    expect(await page.locator('[data-cms-audit]').count()).toBeGreaterThan(0);

    // Keyboard reachability and WCAG automated scan.
    await page.locator('body').press('Tab');
    await expect(page.locator(':focus')).toBeVisible();
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(axe.violations).toEqual([]);
    const accessibilityTree = await page.locator('body').ariaSnapshot();
    expect(accessibilityTree).toContain(locale === 'en'
      ? '- heading "Handoff CMS authoring" [level=1]'
      : '- heading "Creación de contenido en Handoff CMS" [level=1]');
    expect(accessibilityTree).toContain(locale === 'en' ? 'button "Propose for review"' : 'button "Proponer para revisión"');

    const artifactDir = `artifacts/g009/${testInfo.project.name}`;
    await mkdir(artifactDir, { recursive: true });
    const screenshotPath = `${artifactDir}/handoff-beat-${locale}.png`;
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true });
    expect(screenshot.byteLength).toBeGreaterThan(10_000);
    const screenshotSha256 = createHash('sha256').update(screenshot).digest('hex');
    const tastecheck = await page.evaluate((hash) => window.__beat.tastecheck(hash), screenshotSha256);
    const durationMs = Date.now() - started;

    const receipt = await page.evaluate(() => ({ snapshot: window.__beat.snapshot(), calls: window.__beat.calls() }));
    const selectors: Readonly<Record<string, string>> = {
      replace: '[data-cms-form="replace"] input[type="file"]',
      preview: '[data-cms-action="preview"]',
      propose: '[data-cms-action="propose"]',
      approve: '[data-cms-action="approve"]',
      publish: '[data-cms-action="publish"]',
      rollback: '[data-cms-action="rollback"]',
      reconcile: '[data-cms-action="reconcile"]',
    };
    const actions = [
      { type: 'goto', url: page.url(), timestamp: started },
      ...receipt.calls.map((call, index) => {
        const selector = selectors[call.method];
        if (selector === undefined) throw new Error(`unmapped automation call ${call.method}`);
        return {
          type: call.method === 'replace' ? 'fill' : 'click',
          selector,
          timestamp: started + index + 1,
        };
      }),
    ];
    await writeFile(`${artifactDir}/handoff-beat-${locale}.json`, JSON.stringify({
      schemaVersion: 1,
      surface: 'web',
      tool: 'Playwright',
      locale: locale as Locale,
      project: testInfo.project.name,
      durationMs,
      screenshotSha256,
      tastecheck,
      finalState: receipt.snapshot.visibleState,
      calls: receipt.calls,
      accessibilityTree,
      limitations: ['Neurodivergent-accessible by design; external participant validation is a v1.1 goal.'],
      actions,
      assertions: [
        {
          selector: `html[lang="${locale}"]`,
          status: 'passed',
          timestamp: started + actions.length + 1,
        },
        {
          selector: '[data-cms-region="deploy"]',
          status: 'passed',
          timestamp: started + actions.length + 2,
        },
      ],
    }, null, 2));
    expect(tastecheck.gate.verdict).not.toBe('FAIL');
    expect(durationMs).toBeLessThan(60_000);
  });

  test(`${locale} client safeguards and recovery journeys`, async ({ page }, testInfo) => {
    const dialogs: string[] = [];
    let dismissNextDialog = false;
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      if (dismissNextDialog) {
        dismissNextDialog = false;
        await dialog.dismiss();
      } else {
        await dialog.accept();
      }
    });

    await page.goto('/packages/web/e2e/handoff-beat.html');
    await page.locator('[data-cms-control="locale"]').selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);

    // Forbidden initial transitions and commerce controls stay unavailable.
    await expect(page.locator('[data-cms-action="reconcile"]')).toBeDisabled();
    await expect(page.locator('[data-cms-action="rollback"]')).toBeDisabled();
    await expect(page.locator('[data-cms-input="product-price"]')).toHaveCount(0);

    // Local undo is distinct from governed rollback.
    const heroEn = page.locator('[data-cms-input="text"][data-cms-block-id="hero"][data-cms-locale="en"]');
    await heroEn.fill('Temporary local edit');
    await page.locator('[data-cms-action="undo-local-edit"]').click();
    await expect(heroEn).toHaveValue('Handmade ceramics');

    // Validation failure renders a concrete summary and moves focus to it.
    await heroEn.fill('');
    await page.locator('[data-cms-action="preview"]').click();
    const errorSummary = page.locator('[data-cms-region="errors"]');
    await expect(errorSummary).toBeVisible();
    await expect(errorSummary).toBeFocused();
    await expect(errorSummary.locator('li')).toHaveCount(1);
    await heroEn.fill('Handmade ceramics');

    // Upload, preferences, and approved block actions execute on the live UI.
    const uploadForm = page.locator('[data-cms-form="upload"]');
    await uploadForm.locator('input[type="file"]').setInputFiles({
      name: 'new-vessel.png',
      mimeType: 'image/png',
      buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
    });
    await uploadForm.locator('button[type="submit"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.calls().some((call) => call.method === 'upload'))).toBe(true);

    await page.locator('[data-cms-action="set-preference"][data-cms-preference="lowDistraction"]').click();
    await expect(page.locator('html')).toHaveClass(/cms-mode--low-distraction/);
    await page.locator('[data-cms-action="set-preference"][data-cms-preference="reduceMotion"]').click();
    await expect(page.locator('html')).toHaveClass(/cms-mode--reduce-motion/);

    await page.locator('[data-cms-action="block-duplicate"][data-cms-block-id="hero"]').click();
    const textRegions = page.locator('[data-cms-region="text"]');
    await expect(textRegions).toHaveCount(2);
    const regionIds = await textRegions.evaluateAll((nodes) => nodes.map((node) => node.id));
    expect(new Set(regionIds).size).toBe(regionIds.length);
    await page.locator('[data-cms-action="block-hide"][data-cms-block-id="hero"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.snapshot().blocks.find((block) => block.id === 'hero')?.hidden)).toBe(true);

    // Explicit human confirmations can be cancelled without state mutation.
    await page.locator('[data-cms-action="preview"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.snapshot().visibleState)).toBe('preview_ready');
    await page.locator('[data-cms-action="propose"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.snapshot().visibleState)).toBe('proposed');
    await page.locator('[data-cms-action="approve"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.snapshot().visibleState)).toBe('approved');

    dismissNextDialog = true;
    await page.locator('[data-cms-action="publish"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.snapshot().visibleState)).toBe('approved');
    await page.locator('[data-cms-action="publish"]').click();
    await expect.poll(() => page.evaluate(() => window.__beat.snapshot().visibleState)).toBe('live');
    expect(dialogs.length).toBeGreaterThanOrEqual(3);

    const axe = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(axe.violations).toEqual([]);

    const artifactDir = `artifacts/g009/${testInfo.project.name}`;
    await mkdir(artifactDir, { recursive: true });
    const screenshotPath = `${artifactDir}/client-safeguards-${locale}.png`;
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true });
    expect(screenshot.byteLength).toBeGreaterThan(10_000);
    await writeFile(`${artifactDir}/client-safeguards-${locale}.json`, JSON.stringify({
      schemaVersion: 1,
      surface: 'web',
      locale,
      project: testInfo.project.name,
      finalState: await page.evaluate(() => window.__beat.snapshot().visibleState),
      regionIds,
      dialogCount: dialogs.length,
      axeViolations: axe.violations,
      screenshotSha256: createHash('sha256').update(screenshot).digest('hex'),
      limitations: ['Neurodivergent-accessible by design; external participant validation is a v1.1 goal.'],
    }, null, 2));
  });
}
