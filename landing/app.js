(() => {
  const REPO = { owner: 'ClemenceDB', name: 'prefly' };

  const host = location.hostname;
  const segments = location.pathname.split('/').filter(Boolean);
  const repo = host.endsWith('github.io')
    ? { owner: host.split('.')[0], name: segments[0] || REPO.name }
    : REPO;
  const repoUrl = repo.owner ? `https://github.com/${repo.owner}/${repo.name}` : '';
  const releasesUrl = repoUrl ? `${repoUrl}/releases/latest` : '';

  document.querySelectorAll('[data-github]').forEach((link) => {
    if (repoUrl) link.setAttribute('href', repoUrl);
    else link.setAttribute('title', 'Dépôt à publier — renseigner owner/name dans landing/app.js');
  });

  const year = document.querySelector('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());

  const cards = Array.from(document.querySelectorAll('.download[data-platform]'));
  const primary = document.querySelector('[data-primary-download]');

  const LABELS = {
    'mac-arm64': 'Télécharger pour macOS (Apple Silicon)',
    'mac-intel': 'Télécharger pour macOS (Intel)',
    windows: 'Télécharger pour Windows',
    linux: 'Télécharger pour Linux',
  };

  const assetPatterns = {
    'mac-arm64': /arm64\.dmg$/i,
    'mac-intel': /(x64|intel)\.dmg$/i,
    windows: /\.exe$/i,
    linux: /\.AppImage$/i,
  };

  async function detectPlatform() {
    const ua = navigator.userAgent;
    if (/Windows/i.test(ua)) return 'windows';
    if (/Android/i.test(ua)) return 'web';
    if (/Mac OS X|Macintosh/i.test(ua)) {
      const data = navigator.userAgentData;
      if (data && typeof data.getHighEntropyValues === 'function') {
        try {
          const values = await data.getHighEntropyValues(['architecture']);
          if (values.architecture === 'x86') return 'mac-intel';
        } catch {
          /* keep default */
        }
      }
      return 'mac-arm64';
    }
    if (/Linux/i.test(ua)) return 'linux';
    return 'web';
  }

  if (releasesUrl) {
    cards.forEach((card) => card.setAttribute('href', releasesUrl));
    if (primary) primary.setAttribute('href', releasesUrl);
  }

  const applyRelease = (release) => {
    if (!release || !Array.isArray(release.assets)) return;
    const assets = release.assets
      .map((asset) => asset.browser_download_url)
      .filter((url) => typeof url === 'string');
    cards.forEach((card) => {
      const pattern = assetPatterns[card.dataset.platform];
      const match = pattern ? assets.find((url) => pattern.test(url)) : null;
      if (match) card.setAttribute('href', match);
    });
    if (release.tag_name) {
      document.querySelectorAll('[data-version]').forEach((node) => {
        node.textContent = release.tag_name;
      });
    }
  };

  void detectPlatform().then((platform) => {
    cards.forEach((card) => {
      if (card.dataset.platform === platform) card.classList.add('is-detected');
    });
    if (primary && LABELS[platform]) primary.textContent = LABELS[platform];

    if (!repo.owner) return;
    const cacheKey = `prefly-release:${repo.owner}/${repo.name}`;
    let cached = null;
    try {
      cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
    } catch {
      cached = null;
    }

    const selectOwn = () => {
      if (!primary) return;
      const card = cards.find((item) => item.dataset.platform === platform);
      const href = card?.getAttribute('href');
      if (href && /releases\/download/.test(href)) primary.setAttribute('href', href);
    };

    if (cached) {
      applyRelease(cached);
      selectOwn();
      return;
    }

    fetch(`https://api.github.com/repos/${repo.owner}/${repo.name}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((release) => {
        if (!release) return;
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify(release));
        } catch {
          /* private mode: ignore */
        }
        applyRelease(release);
        selectOwn();
      })
      .catch(() => undefined);
  });
})();
