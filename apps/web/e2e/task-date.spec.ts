import { expect, test } from '@playwright/test';

/** Opt-in mutating acceptance test. Leaves a clearly labelled task as durable evidence; no Git or deployment. */
test('a complete task due date persists after reload and can be cleared', async ({ page }) => {
  test.skip(!process.env.E2E_PASSWORD, 'Provide E2E_EMAIL/E2E_PASSWORD for an authorized test account');
  await page.goto('/login');
  await page.locator('#email').fill(process.env.E2E_EMAIL ?? 'ezgi.demir@arucad.edu.tr');
  await page.locator('#password').fill(process.env.E2E_PASSWORD!);
  await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  await page.goto(`/projects/${process.env.E2E_PROJECT_SLUG ?? 'form'}/tasks`);
  await page.getByRole('button', { name: 'Görev ekle', exact: true }).click();
  const title = `[TEST E2E] Due date ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Başlık', exact: true }).fill(title);
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button').filter({ hasText: title }).click();
  await page.getByRole('link', { name: 'Yorumlar, geçmiş, etiketler ve teslim tarihi →', exact: true }).click();
  const date = page.getByRole('textbox', { name: 'Teslim tarihi', exact: true });
  await date.fill('2030-02-28');
  await page.getByRole('button', { name: 'Teslim tarihini kaydet', exact: true }).click();
  await expect(page.getByText(/teslim tarihini .* yaptı/)).toBeVisible();
  await page.reload();
  await expect(date).toHaveValue('2030-02-28');
  await date.fill('');
  await page.getByRole('button', { name: 'Teslim tarihini kaydet', exact: true }).click();
  await expect(page.getByText('teslim tarihini kaldırdı', { exact: false })).toBeVisible();
  await page.reload();
  await expect(date).toHaveValue('');
});
