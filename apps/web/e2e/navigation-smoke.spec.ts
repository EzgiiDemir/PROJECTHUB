import { expect, test, type Page } from '@playwright/test';

const projectRoutes = [
  '', 'timeline', 'discussion', 'code', 'pull-requests', 'git', 'builds', 'terminal', 'previews', 'simulator',
  'reviews', 'feedback', 'tasks', 'environments', 'deployments', 'versions', 'feature-flags', 'database', 'secrets',
  'ai', 'intelligence', 'security', 'dependencies', 'logs', 'incidents', 'docs', 'guide', 'integrations', 'settings',
];
const globalRoutes = ['/', '/projects', '/projects/new', '/team', '/deployments', '/security', '/archive', '/account', '/admin/users', '/admin/roles', '/admin/system', '/admin/ai', '/admin/settings', '/admin/webhooks', '/admin/audit'];

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#email', process.env.E2E_EMAIL ?? 'ezgidemir824@gmail.com');
  await page.fill('#password', process.env.E2E_PASSWORD ?? '');
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/** Read-only coverage for every primary workspace destination. Mutating, deploy and secret actions are never clicked. */
test('all primary pages render without platform 5xx or visible error states', async ({ page }) => {
  test.skip(!process.env.E2E_PASSWORD, 'Set E2E_EMAIL and E2E_PASSWORD for an organization admin');
  await login(page);
  const platformFailures: string[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === new URL(page.url()).origin && response.status() >= 500) platformFailures.push(`${response.status()} ${url.pathname}`);
  });

  const routes = [...globalRoutes, ...projectRoutes.map((route) => `/projects/form${route ? `/${route}` : ''}`)];
  for (const route of routes) {
    const started = Date.now();
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('h1').first()).toBeVisible();
    await expect(page.getByText(/Beklenmeyen hata|Bir hata oluştu|Internal Server Error/i)).toHaveCount(0);
    expect(Date.now() - started, `${route} took too long to become usable`).toBeLessThan(15_000);
  }
  expect(platformFailures).toEqual([]);
});

