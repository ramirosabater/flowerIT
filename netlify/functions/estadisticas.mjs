// Estadísticas privadas de FloWer: junta Google Analytics (GA4) y Microsoft Clarity.
// Variables de entorno en Netlify (Site configuration → Environment variables):
//   STATS_CLAVE       clave para entrar a /estadisticas
//   GA_PROPERTY_ID    número de la propiedad de Analytics (Administrar → Detalles de la propiedad)
//   GA_CLIENT_EMAIL   "client_email" del JSON de la cuenta de servicio
//   GA_PRIVATE_KEY    "private_key" del mismo JSON (tal cual, con los \n)
//   CLARITY_TOKEN     token de Clarity (Configuración → Exportación de datos → Generar token)
import { createSign, timingSafeEqual, createHash } from 'node:crypto'

export const config = { path: '/api/estadisticas' }

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})
const igual = (a, b) => {
  const x = createHash('sha256').update(String(a)).digest(), y = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(x, y)
}
const b64u = (s) => Buffer.from(s).toString('base64url')

let tokenGA = null, tokenVence = 0
async function accesoGA() {
  if (tokenGA && Date.now() < tokenVence - 60000) return tokenGA
  const email = process.env.GA_CLIENT_EMAIL, key = (process.env.GA_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  if (!email || !key) throw new Error('Falta configurar GA_CLIENT_EMAIL o GA_PRIVATE_KEY en Netlify.')
  const ahora = Math.floor(Date.now() / 1000)
  const sinFirma = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64u(JSON.stringify({
    iss: email, scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: ahora, exp: ahora + 3600,
  }))
  const firma = createSign('RSA-SHA256').update(sinFirma).sign(key, 'base64url')
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: sinFirma + '.' + firma }),
  })
  const d = await r.json()
  if (!r.ok) throw new Error('Google no aceptó la cuenta de servicio: ' + (d.error_description || d.error || r.status))
  tokenGA = d.access_token; tokenVence = Date.now() + d.expires_in * 1000
  return tokenGA
}

async function ga(metodo, cuerpo) {
  const id = process.env.GA_PROPERTY_ID
  if (!id) throw new Error('Falta configurar GA_PROPERTY_ID en Netlify.')
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${id}:${metodo}`, {
    method: 'POST', headers: { authorization: 'Bearer ' + (await accesoGA()), 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  })
  const d = await r.json()
  if (!r.ok) {
    const m = d.error?.message || r.status
    throw new Error(r.status === 403 ? 'La cuenta de servicio no tiene acceso a la propiedad de Analytics. Agregala como Lector en Administrar → Gestión de acceso.' : 'Analytics: ' + m)
  }
  return d
}

// Pasa un informe de GA4 a filas simples { dimension: valor, metrica: número }
function filas(rep) {
  const dims = (rep.dimensionHeaders || []).map((h) => h.name), mets = (rep.metricHeaders || []).map((h) => h.name)
  return (rep.rows || []).map((row) => {
    const o = {}
    dims.forEach((n, i) => { o[n] = row.dimensionValues[i].value })
    mets.forEach((n, i) => { o[n] = Number(row.metricValues[i].value) })
    return o
  })
}

async function datosGA(dias) {
  const rango = [{ startDate: `${dias - 1}daysAgo`, endDate: 'today' }]
  const previo = [{ startDate: `${dias * 2 - 1}daysAgo`, endDate: `${dias}daysAgo` }]
  const totales = ['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'averageSessionDuration', 'engagementRate'].map((name) => ({ name }))
  const lote = await ga('batchRunReports', { requests: [
    { dateRanges: rango, dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }], orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400 },
    { dateRanges: rango, dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'userEngagementDuration' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 15 },
    { dateRanges: rango, dimensions: [{ name: 'sessionDefaultChannelGroup' }, { name: 'sessionSource' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 12 },
    { dateRanges: rango, dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
      dimensionFilter: { orGroup: { expressions: [
        { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'clic_whatsapp' } } },
        { filter: { fieldName: 'eventName', stringFilter: { matchType: 'BEGINS_WITH', value: 'abrir_demo_' } } },
      ] } }, orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 30 },
    { dateRanges: [...rango, ...previo], metrics: totales },
  ] })
  const lote2 = await ga('batchRunReports', { requests: [
    { dateRanges: rango, dimensions: [{ name: 'deviceCategory' }], metrics: [{ name: 'sessions' }] },
    { dateRanges: rango, dimensions: [{ name: 'city' }, { name: 'region' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }], limit: 10 },
    { dateRanges: rango, dimensions: [{ name: 'dayOfWeek' }, { name: 'hour' }], metrics: [{ name: 'sessions' }], limit: 200 },
  ] })
  let ahora = 0
  try { const rt = await ga('runRealtimeReport', { metrics: [{ name: 'activeUsers' }] }); ahora = Number(rt.rows?.[0]?.metricValues?.[0]?.value || 0) } catch { /* sin tiempo real */ }
  const [porDia, paginas, fuentes, eventos, tot] = lote.reports
  const [disp, ciudades, calor] = lote2.reports
  const t = (tot.rows || []).map((r) => Object.fromEntries(tot.metricHeaders.map((h, i) => [h.name, Number(r.metricValues[i].value)])))
  // con dos rangos, GA agrega la dimensión dateRange: la fila "date_range_0" es el actual
  const rowsTot = (tot.rows || []).map((r) => ({ rango: r.dimensionValues?.[0]?.value, v: Object.fromEntries(tot.metricHeaders.map((h, i) => [h.name, Number(r.metricValues[i].value)])) }))
  const actual = rowsTot.find((x) => x.rango === 'date_range_0')?.v || t[0] || {}
  const anterior = rowsTot.find((x) => x.rango === 'date_range_1')?.v || t[1] || null
  return {
    ahora, totales: actual, anterior,
    porDia: filas(porDia), paginas: filas(paginas), fuentes: filas(fuentes), eventos: filas(eventos),
    dispositivos: filas(disp), ciudades: filas(ciudades), calor: filas(calor),
  }
}

// Clarity permite 10 consultas por día: se guarda la respuesta 2 horas en memoria
const cacheClarity = new Map()
async function datosClarity(dias) {
  const token = process.env.CLARITY_TOKEN
  if (!token) throw new Error('Falta configurar CLARITY_TOKEN en Netlify.')
  const c = cacheClarity.get(dias)
  if (c && Date.now() - c.t < 2 * 3600 * 1000) return { ...c.d, cache: c.t }
  const pedir = (dim) => fetch(`https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=${dias}${dim ? '&dimension1=' + dim : ''}`, {
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  }).then(async (r) => { if (!r.ok) throw new Error(r.status === 429 ? 'Clarity: se llegó al límite de 10 consultas por día. Probá mañana.' : r.status === 401 ? 'Clarity rechazó el token. Generá uno nuevo.' : 'Clarity: error ' + r.status); return r.json() })
  const general = await pedir('')
  let porDispositivo = null
  try { porDispositivo = await pedir('Device') } catch { /* opcional */ }
  const d = { general, porDispositivo, dias }
  cacheClarity.set(dias, { t: Date.now(), d })
  return { ...d, cache: Date.now() }
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Usá POST.' }, 405)
  let body = {}
  try { body = await req.json() } catch { /* vacío */ }
  const clave = process.env.STATS_CLAVE
  if (!clave) return json({ error: 'Falta configurar STATS_CLAVE en Netlify.' }, 500)
  if (!body.clave || !igual(body.clave, clave)) {
    await new Promise((r) => setTimeout(r, 800))
    return json({ error: 'Clave incorrecta.' }, 401)
  }
  const dias = [7, 28, 90].includes(Number(body.dias)) ? Number(body.dias) : 28
  const out = { dias, generado: new Date().toISOString() }
  if (body.que !== 'clarity') {
    try { out.ga = await datosGA(dias) } catch (e) { out.gaError = e.message }
  }
  if (body.que === 'clarity' || body.que === 'todo') {
    try { out.clarity = await datosClarity(Math.min(3, Number(body.diasClarity) || 3)) } catch (e) { out.clarityError = e.message }
  }
  return json(out)
}
