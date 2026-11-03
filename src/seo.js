// robots.txt, sitemap.xml и запрет индексации тестовой среды (stage.*).
export const SITE_URL = 'https://finnikbot.ru';
const PUBLIC_PAGES = ['/', '/legal/offer', '/legal/privacy', '/legal/consent', '/legal/cookies', '/blog/kak-vesti-uchet-rashodov/', '/blog/alternativa-excel-uchet-finansov/'];

export const isStageHost = (host = '') => /^stage\./i.test(String(host).split(':')[0]);

export function robotsTxt(host) {
  if (isStageHost(host)) return 'User-agent: *\nDisallow: /\n';
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /cabinet/',
    'Disallow: /api/',
    'Disallow: /webhook/',
    '',
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    '',
  ].join('\n');
}

export function sitemapXml() {
  const urls = PUBLIC_PAGES.map((p) => `  <url><loc>${SITE_URL}${p}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// Подключать до express.static
export function addSeoRoutes(app) {
  app.use((req, res, next) => {
    if (isStageHost(req.headers.host)) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  // Страницы-списка «Блог» пока нет: адрес /blog/ временно ведёт на единственную статью (302, чтобы поисковики не запоминали это навсегда).
  // Когда статей станет 3+, здесь вместо редиректа отдаём страницу блога.
  app.get('/blog', (req, res) => res.redirect(302, '/blog/kak-vesti-uchet-rashodov/'));
  app.get('/robots.txt', (req, res) => res.type('text/plain; charset=utf-8').send(robotsTxt(req.headers.host)));
  app.get('/sitemap.xml', (req, res) => {
    if (isStageHost(req.headers.host)) return res.status(404).end();
    res.type('application/xml; charset=utf-8').send(sitemapXml());
  });
}
