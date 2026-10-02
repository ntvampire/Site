const fs = require('fs');
const path = require('path');
const https = require('https');

// Configuration
const GITHUB_USERNAME = process.env.GH_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const EXCLUDE_FORKS = process.env.EXCLUDE_FORKS !== 'false';
const EXCLUDE_ARCHIVED = process.env.EXCLUDE_ARCHIVED !== 'false';
const EXCLUDE_REPOS = (process.env.EXCLUDE_REPOS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'GitHub-Site-Generator',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...headers
      }
    };

    https.get(options, (res) => {
      let data = '';
      if (res.statusCode === 404) {
        return resolve(null); // Not found is acceptable (e.g., no releases or file)
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`GitHub API HTTP ${res.statusCode} for ${url}: ${res.statusMessage}`));
      }
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function fetchAllRepos(username, token) {
  let repos = [];
  let page = 1;
  const perPage = 100;
  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  while (true) {
    const url = `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=${perPage}&page=${page}&sort=pushed&direction=desc`;
    console.log(`Fetching repositories (page ${page})...`);
    const batch = await fetchJson(url, headers);
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos = repos.concat(batch);
    if (batch.length < perPage) break;
    page++;
  }

  return repos;
}

async function inspectRepoExtras(repo, token) {
  const headers = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const owner = repo.owner.login;
  const repoName = repo.name;
  const defaultBranch = repo.default_branch || 'main';
  const hasPages = Boolean(repo.has_pages);

  // Base URL for served files: prefer github.io if Pages enabled
  const fileBaseUrl = hasPages
    ? `https://${owner.toLowerCase()}.github.io/${repoName}/`
    : `https://raw.githubusercontent.com/${owner}/${repoName}/${defaultBranch}/`;

  let latestRelease = null;
  let rootFiles = [];
  let portfolioConfig = null;

  // 1. Fetch latest release
  try {
    const releaseUrl = `https://api.github.com/repos/${owner}/${repoName}/releases/latest`;
    latestRelease = await fetchJson(releaseUrl, headers);
  } catch (err) {
    console.warn(`Could not fetch releases for ${repoName}: ${err.message}`);
  }

  // 2. Fetch root directory contents
  try {
    const contentsUrl = `https://api.github.com/repos/${owner}/${repoName}/contents`;
    const contents = await fetchJson(contentsUrl, headers);
    if (Array.isArray(contents)) {
      rootFiles = contents;
    }
  } catch (err) {
    console.warn(`Could not fetch contents for ${repoName}: ${err.message}`);
  }

  // 3. Check for .portfolio.json or portfolio.json (Universal fallback config)
  const configFile = rootFiles.find(f => f.name === '.portfolio.json' || f.name === 'portfolio.json');
  if (configFile && configFile.download_url) {
    try {
      const configRes = await fetchJson(configFile.download_url);
      if (configRes && typeof configRes === 'object') {
        portfolioConfig = configRes;
      }
    } catch (e) {
      console.warn(`Could not parse portfolio config in ${repoName}: ${e.message}`);
    }
  }

  const actions = [];

  // Manual actions from .portfolio.json take precedence if provided
  if (portfolioConfig && Array.isArray(portfolioConfig.actions)) {
    actions.push(...portfolioConfig.actions);
  } else {
    // --- Automatic Detection ---

    // A. Releases & Downloads (e.g., Android APK, Windows EXE, etc.)
    if (latestRelease && Array.isArray(latestRelease.assets) && latestRelease.assets.length > 0) {
      // Find prominent downloadable assets
      const relevantAssets = latestRelease.assets.filter(a => {
        const ext = path.extname(a.name).toLowerCase();
        return ['.apk', '.exe', '.msi', '.zip', '.tar.gz', '.appimage', '.dmg', '.deb'].includes(ext);
      });

      const targets = relevantAssets.length > 0 ? relevantAssets : latestRelease.assets.slice(0, 2);
      for (const asset of targets) {
        const ext = path.extname(asset.name).toLowerCase();
        let typeBadge = 'Файл';
        if (ext === '.apk') typeBadge = 'APK';
        else if (ext === '.exe' || ext === '.msi') typeBadge = 'EXE';
        else if (ext === '.zip' || ext === '.tar.gz') typeBadge = 'ZIP';

        actions.push({
          type: 'download',
          label: `Скачать ${typeBadge} (${latestRelease.tag_name})`,
          fileName: asset.name,
          url: asset.browser_download_url,
          tag: latestRelease.tag_name,
          size: formatBytes(asset.size)
        });
      }
    }

    // B. PowerShell executable script (e.g., Win11Lite start.ps1)
    const ps1Files = rootFiles.filter(f => f.type === 'file' && f.name.toLowerCase().endsWith('.ps1'));
    if (ps1Files.length > 0) {
      // Prefer start.ps1, run.ps1, or {repoName}.ps1, otherwise the first .ps1 found
      const preferred = ps1Files.find(f => ['start.ps1', 'run.ps1', 'setup.ps1', `${repoName.toLowerCase()}.ps1`].includes(f.name.toLowerCase()))
        || ps1Files[0];

      if (preferred) {
        const scriptUrl = `${fileBaseUrl}${preferred.name}`;
        actions.push({
          type: 'command',
          label: 'Запуск в PowerShell',
          command: `irm ${scriptUrl} | iex`,
          copyText: `irm ${scriptUrl} | iex`,
          note: 'PowerShell однострочник'
        });
      }
    }

    // C. IPTV / M3U playlist file (e.g., IPTV index.m3u)
    const m3uFile = rootFiles.find(f => f.type === 'file' && (f.name.toLowerCase().endsWith('.m3u') || f.name.toLowerCase().endsWith('.m3u8')));
    if (m3uFile) {
      const playlistUrl = `${fileBaseUrl}${m3uFile.name}`;
      actions.push({
        type: 'copy_link',
        label: 'Плейлист M3U',
        url: playlistUrl,
        copyText: playlistUrl,
        note: 'Ссылка для плеера (IPTV)'
      });
    }

    // D. Shell/Bash script install (if install.sh / setup.sh exists)
    const shFile = rootFiles.find(f => f.type === 'file' && ['install.sh', 'setup.sh'].includes(f.name.toLowerCase()));
    if (shFile) {
      const scriptUrl = `${fileBaseUrl}${shFile.name}`;
      actions.push({
        type: 'command',
        label: 'Запуск в Bash',
        command: `curl -fsSL ${scriptUrl} | bash`,
        copyText: `curl -fsSL ${scriptUrl} | bash`,
        note: 'Bash однострочник'
      });
    }
  }

  return {
    actions,
    customDescription: portfolioConfig && portfolioConfig.description,
    hide: portfolioConfig && portfolioConfig.hide === true
  };
}

function getMockRepos() {
  return [
    {
      name: "ATV-Hub",
      description: "Universal Android TV Launcher & Media Player (ATV 9+)",
      html_url: "https://github.com/ntvampire/ATV-Hub",
      homepage: "",
      language: "Kotlin",
      topics: ["android-tv", "leanback", "launcher"],
      pushed_at: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString(),
      fork: false,
      archived: false,
      owner: { login: "ntvampire" },
      has_pages: false,
      default_branch: "main"
    },
    {
      name: "Win11Lite",
      description: "Windows 10/11 x64 optimization script for slow HDD and 4GB RAM",
      html_url: "https://github.com/ntvampire/Win11Lite",
      homepage: "https://ntvampire.github.io/Win11Lite/",
      language: "PowerShell",
      topics: ["powershell", "windows-optimization", "debloat"],
      pushed_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
      fork: false,
      archived: false,
      owner: { login: "ntvampire" },
      has_pages: true,
      default_branch: "main"
    },
    {
      name: "IPTV",
      description: "my iptv playlist",
      html_url: "https://github.com/ntvampire/IPTV",
      homepage: "https://ntvampire.github.io/IPTV/",
      language: "Python",
      topics: ["iptv", "m3u", "playlist"],
      pushed_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 5).toISOString(),
      fork: false,
      archived: false,
      owner: { login: "ntvampire" },
      has_pages: true,
      default_branch: "main"
    }
  ];
}

async function main() {
  let rawRepos = [];
  let userLogin = GITHUB_USERNAME;

  if (GITHUB_USERNAME) {
    try {
      console.log(`Connecting to GitHub API for user: ${GITHUB_USERNAME}...`);
      rawRepos = await fetchAllRepos(GITHUB_USERNAME, GITHUB_TOKEN);
      console.log(`Successfully fetched ${rawRepos.length} repositories from GitHub.`);
    } catch (err) {
      console.error(`Error fetching repositories: ${err.message}`);
      console.warn("Falling back to mock repositories for development build...");
      rawRepos = getMockRepos();
    }
  } else {
    console.log("No GH_USERNAME or GITHUB_REPOSITORY_OWNER specified. Using mock repositories...");
    rawRepos = getMockRepos();
    userLogin = "ntvampire";
  }

  // Filter repos
  const filteredRepos = rawRepos.filter(repo => {
    if (EXCLUDE_FORKS && repo.fork) return false;
    if (EXCLUDE_ARCHIVED && repo.archived) return false;
    if (EXCLUDE_REPOS.includes(repo.name.toLowerCase())) return false;
    if (repo.topics && repo.topics.includes('portfolio-hide')) return false;
    return true;
  });

  console.log(`Analyzing extras (releases, files, scripts) for ${filteredRepos.length} repositories...`);

  const normalized = [];
  for (const repo of filteredRepos) {
    console.log(`-> Inspecting extras for ${repo.name}...`);
    const extras = await inspectRepoExtras(repo, GITHUB_TOKEN);

    if (extras.hide) {
      console.log(`Skipping ${repo.name} because hide=true in config.`);
      continue;
    }

    normalized.push({
      name: repo.name,
      description: extras.customDescription || repo.description || 'Нет описания',
      url: repo.html_url,
      homepage: repo.homepage || '',
      language: repo.language || null,
      topics: Array.isArray(repo.topics) ? repo.topics : [],
      updatedAt: repo.pushed_at ? new Date(repo.pushed_at).toISOString() : new Date().toISOString(),
      actions: extras.actions || []
    });
  }

  // Sort by updatedAt descending
  normalized.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const distDir = path.join(__dirname, '..', 'dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  // Generate HTML
  const templatePath = path.join(__dirname, '..', 'src', 'index.html');
  let htmlTemplate = fs.readFileSync(templatePath, 'utf8');

  const generatedDate = new Date().toISOString();
  const projectsDataScript = `<script>window.PROJECTS_DATA = ${JSON.stringify(normalized)}; window.BUILD_INFO = ${JSON.stringify({ generatedDate, username: userLogin, count: normalized.length })};</script>`;

  htmlTemplate = htmlTemplate
    .replace('<!-- PROJECTS_DATA_PLACEHOLDER -->', projectsDataScript)
    .replace(/__USERNAME__/g, userLogin || 'GitHub Projects');

  fs.writeFileSync(path.join(distDir, 'index.html'), htmlTemplate, 'utf8');
  console.log(`Build completed! ${normalized.length} projects written to dist/index.html.`);
}

main().catch(err => {
  console.error("Build failed:", err);
  process.exit(1);
});
