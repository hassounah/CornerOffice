import { describe, it, expect } from 'vitest'
import { isSecret } from '../main/services/secret-patterns'

// ---------------------------------------------------------------------------
// One positive per pattern (§10.6, including the L7 additions)
// ---------------------------------------------------------------------------

const POSITIVE_CASES: Array<[pattern: string, example: string]> = [
  ['.env', '.env'],
  ['.env.*', '.env.local'],
  ['.envrc', '.envrc'],
  ['*.pem', 'server.pem'],
  ['*.key', 'private.key'],
  ['*.p12', 'cert.p12'],
  ['*.pfx', 'cert.pfx'],
  ['*.p8', 'auth.p8'],
  ['*.jks', 'app.jks'],
  ['*.keystore', 'app.keystore'],
  ['*.ppk', 'putty.ppk'],
  ['id_rsa*', 'id_rsa'],
  ['id_dsa*', 'id_dsa'],
  ['id_ecdsa*', 'id_ecdsa'],
  ['id_ed25519*', 'id_ed25519'],
  ['credentials', 'credentials'],
  ['credentials*.json', 'credentials-prod.json'],
  ['*.credentials', 'aws.credentials'],
  ['client_secret*.json', 'client_secret_123.json'],
  ['service-account*.json', 'service-account-1.json'],
  ['.npmrc', '.npmrc'],
  ['.pypirc', '.pypirc'],
  ['.netrc', '.netrc'],
  ['_netrc', '_netrc'],
  ['.git-credentials', '.git-credentials'],
  ['.htpasswd', '.htpasswd'],
  ['.dockercfg', '.dockercfg'],
  ['secrets.yml', 'secrets.yml'],
  ['secrets.yaml', 'secrets.yaml'],
  ['secrets.json', 'secrets.json'],
  ['secrets.toml', 'secrets.toml'],
  ['*.secret', 'app.secret'],
  ['*.secrets', 'app.secrets'],
  ['*.tfvars', 'terraform.tfvars'],
  // L7 additions
  ['*.tfstate', 'terraform.tfstate'],
  ['*.tfstate.backup', 'terraform.tfstate.backup'],
  ['.pgpass', '.pgpass'],
  ['*.kdbx', 'vault.kdbx'],
  ['kubeconfig', 'kubeconfig'],
  ['.s3cfg', '.s3cfg'],
  ['*.gpg', 'key.gpg'],
  ['secring.*', 'secring.gpg'],
  ['local.settings.json', 'local.settings.json'],
]

describe('isSecret — one positive per §10.6 pattern', () => {
  it.each(POSITIVE_CASES)('matches pattern %s via %s', (_pattern, example) => {
    expect(isSecret(example)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Template / public-key exclusions
// ---------------------------------------------------------------------------

describe('isSecret — exclusions', () => {
  it.each([
    '.env.example',
    '.env.sample',
    '.env.template',
    '.env.dist',
  ])('does not flag the .env template %s', (name) => {
    expect(isSecret(name)).toBe(false)
  })

  it('does not flag id_ed25519.pub (public key)', () => {
    expect(isSecret('id_ed25519.pub')).toBe(false)
  })

  it.each(['id_rsa.pub', 'id_dsa.pub', 'id_ecdsa.pub'])(
    'does not flag %s (public key)',
    (name) => {
      expect(isSecret(name)).toBe(false)
    },
  )
})

// ---------------------------------------------------------------------------
// Case insensitivity
// ---------------------------------------------------------------------------

describe('isSecret — case insensitivity', () => {
  it('matches ID_RSA (uppercase)', () => {
    expect(isSecret('ID_RSA')).toBe(true)
  })

  it('matches .ENV (uppercase)', () => {
    expect(isSecret('.ENV')).toBe(true)
  })

  it('does not flag .ENV.EXAMPLE (uppercase template)', () => {
    expect(isSecret('.ENV.EXAMPLE')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Ordinary, non-secret files
// ---------------------------------------------------------------------------

describe('isSecret — non-secret files', () => {
  it.each(['readme.md', 'index.ts', 'package.json', 'trd.md', '.gitignore'])(
    'does not flag %s',
    (name) => {
      expect(isSecret(name)).toBe(false)
    },
  )
})
