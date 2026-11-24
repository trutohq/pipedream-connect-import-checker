import { readFileSync } from 'node:fs'
import { cheapReadUrl } from './import'

// apps.json: one entry per Pipedream app slug. The dry run uses clientId and requiredScopes.
// --import needs every field.
export type AppConfig = {
  clientId?: string // the provider's client ID of your OAuth app, the same one set in Truto
  pdOauthAppId?: string // your custom OAuth client in Pipedream (oa_...)
  envIntegrationId?: string // the installed integration in Truto
  requiredScopes?: string[] // what your Truto calls need
  cheapRead?: string // one small Unified API read, a path on api.truto.one
}

export type ImportApp = Required<AppConfig>

export function loadConfig(path: string): Record<string, AppConfig> {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path}: expected an object keyed by app slug`)
  const out: Record<string, AppConfig> = {}
  for (const [slug, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: ${slug} must be an object`)
    const v = value as Record<string, unknown>
    const cfg: AppConfig = {}
    for (const key of ['clientId', 'pdOauthAppId', 'envIntegrationId', 'cheapRead'] as const) {
      if (v[key] === undefined) continue
      if (typeof v[key] !== 'string' || !v[key]) throw new Error(`${path}: ${slug}.${key} must be a non-empty string`)
      cfg[key] = v[key] as string
    }
    if (v.requiredScopes !== undefined) {
      if (!Array.isArray(v.requiredScopes) || !v.requiredScopes.every((s) => typeof s === 'string' && s)) {
        throw new Error(`${path}: ${slug}.requiredScopes must be an array of non-empty strings`)
      }
      cfg.requiredScopes = v.requiredScopes as string[]
    }
    out[slug] = cfg
  }
  return out
}

// Import mode refuses to start unless every field is set. An empty clientId would let
// `undefined === undefined` pass the OAuth client check.
export function requireImportApp(slug: string, cfg: AppConfig | undefined): ImportApp {
  if (!cfg) throw new Error(`No entry for "${slug}" in the config file`)
  const missing = (['clientId', 'pdOauthAppId', 'envIntegrationId', 'cheapRead'] as const).filter((k) => !cfg[k])
  if (!cfg.requiredScopes) missing.push('requiredScopes' as never)
  if (missing.length) throw new Error(`${slug}: --import needs ${missing.join(', ')} in the config file`)
  if (!/^oa_[0-9a-zA-Z]+$/.test(cfg.pdOauthAppId!)) throw new Error(`${slug}.pdOauthAppId must look like oa_...`)
  // Check it now, before anything is imported. URL() treats inputs such as "/\\evil.example"
  // or "/\t/evil.example" as another host, so test the parsed result, not the prefix.
  let ok = cfg.cheapRead!.startsWith('/')
  try {
    cheapReadUrl(cfg.cheapRead!, 'check')
  } catch {
    ok = false
  }
  if (!ok) throw new Error(`${slug}.cheapRead must be a path on api.truto.one, such as /unified/crm/contacts?limit=1`)
  return cfg as ImportApp
}
