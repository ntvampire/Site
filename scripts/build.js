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
        ...headers
      }
    };

    https.get(options, (res) => {
      let data = '';
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`GitHub API HTTP ${res.statusCode}: ${res.statusMessage}`));
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

function getMockRepos() {
  return [
    {
      name: "portfolio-cms",
      description: "Минималистичная система управления контентом и портфолио для разработчиков",
      html_url: "https://github.com/example/portfolio-cms",
      homepage: "https://example.github.io/portfolio-cms",
      language: "TypeScript",
      topics: ["cms", "typescript", "jamstack"],
      pushed_at: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString(),
      fork: false,
      archived: false
    },
    {
      name: "neural-parser",
      description: "Высокоскоростной синтаксический анализатор логов на Rust",
      html_url: "https://github.com/example/neural-parser",
      homepage: "",
      language: "Rust",
      topics: ["parser", "rust", "cli"],
      pushed_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
      fork: false,
      archived: false
    },
    {
      name: "api-gateway-service",
      description: "Легковесный шлюз API с балансировкой нагрузки и аутентификацией по JWT",
      html_url: "https://github.com/example/api-gateway-service",
      homepage: "",
      language: "Go",
      topics: ["gateway", "go", "microservices", "docker"],
      pushed_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString(),
      fork: false,
      archived: false
    },
    {
      name: "data-pipeline-runner",
      description: "Асинхронный пайплайн обработки потоковых событий",
      html_url: "https://github.com/example/data-pipeline-runner",
      homepage: "",
      language: "Python",
      topics: ["python", "asyncio", "etl"],
      pushed_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14).toISOString(),
      fork: false,
      archived: false
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
    userLogin = "Developer";
  }

  // Filter repos
  const filteredRepos = rawRepos.filter(repo => {
    if (EXCLUDE_FORKS && repo.fork) return false;
    if (EXCLUDE_ARCHIVED && repo.archived) return false;
    if (EXCLUDE_REPOS.includes(repo.name.toLowerCase())) return false;
    if (repo.topics && repo.topics.includes('portfolio-hide')) return false;
    return true;
  });

  // Normalize data
  const normalized = filteredRepos.map(repo => {
    return {
      name: repo.name,
      description: repo.description || 'Нет описания',
      url: repo.html_url,
      homepage: repo.homepage || '',
      language: repo.language || null,
      topics: Array.isArray(repo.topics) ? repo.topics : [],
      updatedAt: repo.pushed_at ? new Date(repo.pushed_at).toISOString() : new Date().toISOString()
    };
  });

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
