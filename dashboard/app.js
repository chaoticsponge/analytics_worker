'use strict';
const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => new Intl.NumberFormat().format(value || 0);
const percent = value => value == null ? '—' : `${Math.round(value)}%`;
const seconds = value => value == null ? '—' : value < 60 ? `${Math.round(value)}s` : `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
let data = null, sort = 'views', ascending = false;
function signal(page) {
  if (page.views < 20 || page.measured < 20) return ['Limited sample', 'neutral'];
  if (page.scroll < 40) return ['Review content', 'warn'];
  if (page.scroll >= 70 && page.duration >= 30) return ['Strong engagement', ''];
  return ['Monitor', 'neutral'];
}
function renderPages() {
  if (!data) return;
  const search = $('search').value.toLowerCase();
  const pages = data.pages.filter(p => p.path.toLowerCase().includes(search)).sort((a,b) => {
    const x = a[sort], y = b[sort];
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * (ascending ? 1 : -1);
  });
  $('pages').innerHTML = pages.length ? pages.map(p => {
    const [label, style] = signal(p);
    return `<tr><td>${escape(p.path)}</td><td>${number(p.views)}</td><td>${seconds(p.duration)}</td><td>${percent(p.scroll)}</td><td><span class="badge ${style}">${label}</span></td></tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">No matching pages in this period.</td></tr>';
  document.querySelectorAll('[data-sort]').forEach(button => button.closest('th').setAttribute('aria-sort', button.dataset.sort === sort ? (ascending ? 'ascending' : 'descending') : 'none'));
}
function renderBars(id, rows, total) {
  const selected = rows.slice(0, 6), max = Math.max(1, ...selected.map(r => r.views));
  $(id).innerHTML = selected.length ? selected.map(r => `<div class="bar-row"><span class="bar-label" title="${escape(r.label)}">${escape(r.label)}</span><div class="bar-track"><div class="bar-fill"></div></div><span class="bar-value">${number(r.views)}</span><span class="bar-percent">${percent(total ? r.views / total * 100 : 0)}</span></div>`).join('') : '<div class="empty">No recorded data for this period.</div>';
  // Scale without inline style attributes, keeping the content security policy strict.
  $(id).querySelectorAll('.bar-fill').forEach((bar, index) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 100 6'); svg.setAttribute('preserveAspectRatio','none');
    const rect = document.createElementNS(svg.namespaceURI,'rect');
    rect.setAttribute('width', String(selected[index].views / max * 100)); rect.setAttribute('height','6'); rect.setAttribute('fill','#639c83');
    svg.append(rect); bar.replaceWith(svg);
  });
}
function renderTrend() {
  const updated = new Date(data.updated), daily = new Map(data.daily.map(d => [d.day, d.views]));
  const dates = Array.from({length:data.days}, (_, i) => {
    const date = new Date(updated); date.setUTCDate(date.getUTCDate() - data.days + 1 + i);
    return date.toISOString().slice(0,10);
  });
  const values = dates.map(date => daily.get(date) || 0);
  const max = Math.max(1, ...values), top = max < 4 ? 4 : Math.ceil(max / 4) * 4;
  const x = i => 48 + i / (dates.length - 1) * 900;
  const y = value => 196 - value / top * 160;
  const points = values.map((v,i) => `${x(i)},${y(v)}`).join(' ');
  let svg = '<svg viewBox="0 0 980 240" role="img"><title>Daily pageviews in UTC</title>';
  for (let i=0;i<=4;i++) {
    const yy = y(top / 4 * i);
    svg += `<line x1="48" x2="948" y1="${yy}" y2="${yy}" stroke="#e9eee6" stroke-dasharray="3 4"/><text x="34" y="${yy+3}" text-anchor="end">${number(top/4*i)}</text>`;
  }
  svg += `<polygon points="48,196 ${points} 948,196" fill="#edf4eb"/><polyline points="${points}" fill="none" stroke="#40866c" stroke-width="2.5"/>`;
  values.forEach((v,i) => {svg += `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="#40866c"><title>${dates[i]}: ${number(v)} pageviews</title></circle>`;});
  [...new Set([0,Math.round((dates.length-1)/4),Math.round((dates.length-1)/2),Math.round((dates.length-1)*3/4),dates.length-1])].forEach(i => {
    const label = new Date(dates[i]+'T00:00:00Z').toLocaleDateString(undefined,{month:'short',day:'numeric',timeZone:'UTC'});
    svg += `<text x="${x(i)}" y="224" text-anchor="middle">${escape(label)}</text>`;
  });
  $('trend').innerHTML = svg + '</svg>';
}
function renderInsights(current, previous) {
  const insights = [];
  const security = data.security_summary[0];
  if (security?.events) insights.push(['SECURITY / REVIEW NOW', 'Investigate suspicious path requests', `${number(security.events)} recorded events target sensitive or commonly probed paths, even with small samples.`, 'Review the security alerts, origin response status, and WAF logs. Confirm secrets and configuration files are inaccessible.']);
  if (current.views && previous.views) {
    const change = (current.views - previous.views) / previous.views * 100;
    insights.push(['TRAFFIC / PERIOD COMPARISON',`Traffic is ${Math.abs(change).toFixed(0)}% ${change >= 0 ? 'higher' : 'lower'}`,`${number(current.views)} views vs. ${number(previous.views)} in the preceding equal-length window. Today is partial; collection coverage is unverified.`, change >= 0 ? 'Check leading pages and sources to understand the increase before repeating a campaign.' : 'Check acquisition changes and collection health before changing your content strategy.']);
  }
  const review = data.pages.find(p => signal(p)[0] === 'Review content');
  if (review) insights.push(['CONTENT / REVIEW', 'A page may need a stronger opening', `${review.path}: ${number(review.views)} views, ${percent(review.scroll)} mean maximum scroll, and ${number(review.measured)} paired measurements.`, 'Review the opening, readability, and mobile layout. Low scroll can also mean visitors found an answer quickly.']);
  const strong = data.pages.find(p => signal(p)[0] === 'Strong engagement');
  if (strong) insights.push(['CONTENT / OPPORTUNITY', 'Build on content people explore', `${strong.path}: ${percent(strong.scroll)} mean maximum scroll and ${seconds(strong.duration)} elapsed time, across ${number(strong.measured)} paired measurements.`, 'Consider related content or a relevant call to action; engagement alone does not prove conversion.']);
  if (current.views && data.devices.length) {
    const device = data.devices.find(d => d.label !== '(unknown)');
    if (device) insights.push(['EXPERIENCE / PRIORITIZE',`Start with ${device.label}`, `${percent(device.views/current.views*100)} of recorded views use this device type.`, 'Test navigation, readability, and key actions on this device first.']);
  }
  insights.push(['MEASUREMENT / NEXT STEP',current.views ? 'Connect attention to outcomes' : 'Establish your measurement baseline',current.views ? 'Pageviews and reading signals show interest. No named conversion goals are present in the current collection schema.' : 'No audience pageviews remain in this window after filtering. Review excluded traffic and collection health.',current.views ? 'Define one meaningful goal and record its completion with the originating page and campaign.' : 'Check the tracker endpoint, allowed origin, and database before interpreting this as zero traffic.']);
  if (insights.length < 3) insights.push(['CONFIDENCE / SAMPLE SIZE','Let the evidence build','Page signals require at least 20 views and 20 paired time/scroll measurements. These are review heuristics, not statistical tests.','Use a wider date range and inspect measurement coverage before prioritizing individual pages.']);
  $('insights').innerHTML = insights.slice(0,3).map(([tag,title,evidence,action]) => `<article class="insight"><span class="priority">${tag}</span><h3>${escape(title)}</h3><p>${escape(evidence)}</p><p class="action">↗ ${escape(action)}</p></article>`).join('');
}
function renderSecurity() {
  const security = data.security_summary[0] || {events:0, paths:0};
  const quality = data.traffic_quality[0] || {};
  $('security-status').textContent = security.events ? `${number(security.events)} flagged events` : 'No matching recorded probes';
  $('security-status').className = `badge ${security.events ? 'danger' : 'neutral'}`;
  $('security-alert').hidden = !security.events;
  $('security-alert').textContent = `${number(security.events)} possible probe events across ${number(security.paths)} paths. Review even a single hit. Verify whether these files exist and whether any response exposed data.`;
  $('traffic-filter').textContent = `Audience metrics exclude ${number(quality.suspicious)} suspicious pageviews and ${number(quality.crawlers)} other crawler-claimed pageviews from ${number(quality.recorded)} recorded pageviews. ${number(quality.unknown_agent)} remaining pageviews have no user agent; these are not verified human visits.`;
  $('security-rows').innerHTML = data.alerts.length ? data.alerts.map(row => `<tr><td>${escape(row.path)}</td><td><span class="badge danger">${escape(row.reason)}</span></td><td>${number(row.events)}</td><td>${escape(new Date(row.last_seen).toISOString().replace('T', ' ').slice(0,19))}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No configured suspicious-path rules matched recorded events in this period. This does not verify site security.</td></tr>';
}
function render() {
  const current = data.summary.find(s => s.period === 'current') || {views:0,browsers:0,countries:0};
  const previous = data.summary.find(s => s.period === 'previous') || {};
  const kpis = [['Audience pageviews','views',number,'Known crawler claims and suspicious paths excluded'],['Recognized browsers','browsers',number,'Distinct stored IDs; not visits or people'],['Average time on page','duration',seconds,'Elapsed time; includes background time'],['Average scroll depth','scroll',percent,'Mean maximum depth; not completion rate']];
  $('kpis').innerHTML = kpis.map(([label,key,format,note]) => {
    const before = previous[key], value = current[key];
    const change = before > 0 && value != null ? (value-before)/before*100 : null;
    return `<article class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${format(value)}</div><div class="kpi-foot">${change == null ? 'No comparison baseline' : `<span class="delta ${change < 0 ? 'down' : ''}">${change >= 0 ? '↗' : '↘'} ${Math.abs(change).toFixed(1)}%</span> vs. previous window`}</div><div class="kpi-foot">${note}</div></article>`;
  }).join('');
  $('kpis').setAttribute('aria-busy','false');
  renderSecurity(); renderTrend(); renderPages(); renderInsights(current,previous);
  const sources = new Map();
  data.sources.forEach(row => {
    let label = row.label;
    try { const url = new URL(label); label = url.hostname; } catch { /* UTM label or direct traffic */ }
    sources.set(label, (sources.get(label) || 0) + row.views);
  });
  renderBars('sources', [...sources].map(([label,views]) => ({label,views})).sort((a,b)=>b.views-a.views),current.views);
  renderBars('countries',data.countries,current.views);
  renderBars('devices',data.devices,current.views);
  renderBars('campaigns',data.campaigns,current.views);
  $('coverage').innerHTML = [['Time coverage','duration_samples'],['Scroll coverage','scroll_samples'],['Browser ID coverage','identified'],['UTM-tagged views','tagged']].map(([label,key])=>`<div><strong>${current.views ? percent((current[key] || 0)/current.views*100) : '—'}</strong>${label}</div>`).join('');
  const observations = [];
  if (!current.views) observations.push('No audience pageviews remain after filtering: review excluded traffic and verify collection before interpreting this period.');
  else {
    if (!current.tagged) observations.push('No UTM-tagged views: use utm_source, utm_medium, and utm_campaign on promotional links to distinguish campaigns.');
    if (data.devices.length === 1) observations.push(`Only one device category is recorded (${data.devices[0].label}). Confirm tracker detection and mobile collection before assuming this reflects your audience.`);
    if (current.duration_samples < current.views || current.scroll_samples < current.views) observations.push('Some engagement measurements are missing or outside their valid range; averages use only valid samples.');
    observations.push('Field coverage does not verify accuracy or detect blocked trackers, missing visits, or bots.');
  }
  $('observations').textContent = observations.join(' ');
  $('connection').textContent = `Connected to ${data.database}`;
  $('updated').textContent = `Updated ${new Date(data.updated).toLocaleString(undefined,{timeZone:'UTC'})} UTC · Includes today`;
}
async function load(refresh = false) {
  $('refresh').disabled = true; $('period').disabled = true;
  $('notice').hidden = false; $('notice').textContent = 'Fetching aggregated data from D1. This can take a moment…';
  try {
    const response = await fetch(`/api/data?days=${$('period').value}${refresh ? '&refresh=1' : ''}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to fetch analytics.');
    data = result; render(); $('notice').hidden = true;
  } catch (error) {
    $('notice').textContent = `${error.message} Click Refresh data to retry.${data ? ' Showing the previous result; its date range and update time remain below.' : ''}`;
    $('connection').textContent = data ? `Refresh failed · Showing ${data.days}-day result` : 'D1 connection unavailable';
    if (data) $('period').value = String(data.days);
  } finally { $('refresh').disabled = false; $('period').disabled = false; }
}
$('refresh').addEventListener('click',()=>load(true));
$('period').addEventListener('change',()=>load());
$('search').addEventListener('input',renderPages);
document.querySelectorAll('[data-sort]').forEach(button=>button.addEventListener('click',()=>{
  if (sort === button.dataset.sort) ascending = !ascending;
  else {sort = button.dataset.sort; ascending = sort === 'path';}
  renderPages();
}));
load();
