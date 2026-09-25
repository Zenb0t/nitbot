// Classifies changed files into review registers. A register decides which
// rulebook the reviewer loads: a migration and a React component fail in
// different ways, and one giant checklist blurs both.
//
// A file gets exactly one primary register; `security` is an overlay that can
// sit on top of any code file.

const GENERATED = /(^|\/)(node_modules|vendor|dist|build|\.next|coverage|target|__generated__|generated)\/|\.min\.(js|css)$|\.(snap|map|lockb)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$|\.pb\.go$|_pb2\.py$/;

const PRIMARY = [
  ['docs', /\.(md|mdx|rst|adoc|txt)$|(^|\/)(docs?|documentation)\/|(^|\/)(LICENSE|CHANGELOG|AUTHORS)[^/]*$/i],
  ['tests', /(^|\/)(__tests__|tests?|spec|specs|e2e|fixtures?)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/],
  ['data', /(^|\/)(migrations?|migrate|alembic|db\/(migrate|schema)|schema)\/|\.sql$|schema\.prisma$|(^|\/)(models?|entities)\/.*\.(py|rb|ts|js)$/],
  ['infra', /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*|\.dockerignore|Makefile|Procfile|Jenkinsfile|\.gitlab-ci\.yml|vercel\.json|netlify\.toml|fly\.toml|railway\.(json|toml)|nginx[^/]*\.conf)$|(^|\/)(\.github\/workflows|\.circleci|\.buildkite|terraform|infra|deploy|k8s|kubernetes|helm|charts|ansible)\/|\.(tf|tfvars|hcl)$/],
  ['deps', /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py|setup\.cfg|Cargo\.toml|go\.mod|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?)$/],
  ['contract', /\.(proto|graphql|gql|avsc)$|(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$|(^|\/)(api|public|sdk)\/|(^|\/)(index|mod)\.(ts|js|mjs)$|(^|\/)__init__\.py$|(^|\/)lib\.rs$|\.d\.ts$/],
];

const SECURITY = /(auth|login|logout|session|token|jwt|oauth|saml|sso|password|passwd|credential|secret|crypto|cipher|hash|permission|rbac|acl|policy|role|sanitiz|escape|csrf|cors|xss|upload|webhook|payment|billing|admin|middleware|guard)/i;
const CODE = /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|py|rb|go|rs|java|kt|cs|php|swift|scala|dart|c|cc|cpp|h|hpp|ex|exs|sh|sql)$/;

export function classify(files) {
  const registers = {};
  const skipped = [];
  const perFile = [];

  for (const f of files) {
    if (GENERATED.test(f.path)) {
      skipped.push(f.path);
      continue;
    }
    const primary = PRIMARY.find(([, re]) => re.test(f.path))?.[0] ?? (CODE.test(f.path) ? 'app' : 'config');
    const tags = [primary];
    if (primary !== 'docs' && primary !== 'tests' && CODE.test(f.path) && SECURITY.test(f.path)) tags.push('security');
    if (!CODE.test(f.path) && /\b(auth|secret|password|token|cors|csp)\b/i.test(f.lines.filter((l) => l.added).map((l) => l.text).join('\n'))) {
      if (!tags.includes('security')) tags.push('security');
    }
    for (const tag of tags) (registers[tag] ??= []).push(f.path);
    perFile.push({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, registers: tags });
  }

  return { registers, skipped, perFile };
}

// Which reference rulebooks to load. `config` rides with infra.
export function rulebooks(registers) {
  const names = new Set(Object.keys(registers).map((r) => (r === 'config' ? 'infra' : r)));
  return [...names].sort().map((r) => `reference/registers/${r}.md`);
}
