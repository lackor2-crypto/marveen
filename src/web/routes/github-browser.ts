// Kanban aa55180c / #14 (14-A, BACKEND): GitHub-repo bongeszo route-jai.
//
// Tukrozi a drive-browser.ts mintajat: a tenyleges GitHub-hozzaferes
// (token-feloldas, API-hivas) a src/github-browse.ts + git-accounts.ts
// `githubRequest` mogott van -- ez a route csak a HTTP-vegpontokat koti be, es
// fioknevet ad at. A TOKEN SOSE megy vissza a bongeszonek: azt a szerver oldja
// fel, a valaszban csak a repo-adat van.
//
// A felulet (14-B) KULON kartyan epul, Boss dontesere var -- ide nem tartozik.
import { readBody, json, reqLang, L } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { gitAccountsWithToken } from '../../git-accounts.js'
import { ghRepos, ghBranches, ghList, ghFile, ghPut } from '../../github-browse.js'
import type { RouteContext } from './types.js'

export async function tryHandleGithubBrowser(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  const lang = reqLang(req, url)

  // Melyik regisztralt fiokhoz van hasznalhato kulcs -- csak nevek, token nelkul.
  if (path === '/api/github/accounts' && method === 'GET') {
    json(res, gitAccountsWithToken())
    return true
  }

  if (path === '/api/github/repos' && method === 'GET') {
    const account = url.searchParams.get('account') || ''
    if (!account) { json(res, { error: L(lang, 'A fiók megadása kötelező.', 'The account is required.') }, 400); return true }
    try {
      json(res, { repos: await ghRepos(account) })
    } catch (err: any) {
      logger.warn({ err: err.message, account }, '[github-browser] repos failed')
      json(res, { error: err.message }, 502)
    }
    return true
  }

  if (path === '/api/github/branches' && method === 'GET') {
    const account = url.searchParams.get('account') || ''
    const repo = url.searchParams.get('repo') || ''
    if (!account || !repo) { json(res, { error: L(lang, 'A fiók és a tároló megadása kötelező.', 'The account and the repository are required.') }, 400); return true }
    try {
      json(res, { branches: await ghBranches(account, repo) })
    } catch (err: any) {
      logger.warn({ err: err.message, account, repo }, '[github-browser] branches failed')
      json(res, { error: err.message }, 502)
    }
    return true
  }

  if (path === '/api/github/list' && method === 'GET') {
    const account = url.searchParams.get('account') || ''
    const repo = url.searchParams.get('repo') || ''
    const ref = url.searchParams.get('ref') || ''
    const p = url.searchParams.get('path') || ''
    if (!account || !repo) { json(res, { error: L(lang, 'A fiók és a tároló megadása kötelező.', 'The account and the repository are required.') }, 400); return true }
    try {
      json(res, { entries: await ghList(account, repo, ref, p) })
    } catch (err: any) {
      logger.warn({ err: err.message, account, repo, ref, path: p }, '[github-browser] list failed')
      json(res, { error: err.message }, 502)
    }
    return true
  }

  if (path === '/api/github/file' && method === 'GET') {
    const account = url.searchParams.get('account') || ''
    const repo = url.searchParams.get('repo') || ''
    const ref = url.searchParams.get('ref') || ''
    const p = url.searchParams.get('path') || ''
    if (!account || !repo || !p) { json(res, { error: L(lang, 'A fiók, a tároló és az útvonal megadása kötelező.', 'The account, the repository and the path are required.') }, 400); return true }
    try {
      json(res, await ghFile(account, repo, ref, p))
    } catch (err: any) {
      logger.warn({ err: err.message, account, repo, ref, path: p }, '[github-browser] file failed')
      json(res, { error: err.message }, 502)
    }
    return true
  }

  // EGY meglevo fajl frissitese. A sha KOTELEZO (nema-feluliras vedelem) -- a
  // hianyat a github-browse.ts 400-nak megfelelo hibaval jelzi.
  if (path === '/api/github/put' && method === 'POST') {
    let data: any
    try { data = JSON.parse((await readBody(req)).toString('utf-8') || '{}') } catch { data = null }
    if (!data || typeof data !== 'object') { json(res, { error: L(lang, 'Hibás kérés.', 'Bad request.'), code: 'bad_json' }, 400); return true }
    const account = String(data.account || '')
    const repo = String(data.repo || '')
    const branch = String(data.branch || '')
    const filePath = String(data.path || '')
    const content = String(data.content || '')
    const sha = String(data.sha || '')
    const message = String(data.message || '')
    if (!account || !repo) { json(res, { error: L(lang, 'A fiók és a tároló megadása kötelező.', 'The account and the repository are required.') }, 400); return true }
    try {
      json(res, await ghPut(account, repo, branch, filePath, content, sha, message))
    } catch (err: any) {
      logger.warn({ err: err.message, account, repo, branch, path: filePath }, '[github-browser] put failed')
      json(res, { error: err.message }, 502)
    }
    return true
  }

  return false
}
