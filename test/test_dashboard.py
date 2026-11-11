"""Exercise dashboard SQL against the real schema and HTTP boundary."""
import importlib.util
import json
from datetime import datetime, timezone
from http.client import HTTPConnection
from http.server import HTTPServer
from pathlib import Path
import sqlite3
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('analytics', ROOT / 'analytics.py')
analytics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analytics)


class QueryTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.executescript((ROOT / 'migrations/0001_create_analytics.sql').read_text())
        self.now = datetime(2026, 11, 12, 12, tzinfo=timezone.utc)
        for day, kind, path, duration, scroll, browser in [
            (12, 'page_view', '/post?a=1', 10000, 80, 'same'),
            (11, 'page_view', '/post?a=2', 30000, 60, 'same'),
            (10, 'page_view', '/other', None, None, None),
            (9, 'page_view', '/bad', -1, 120, None),
            (11, 'click', '/post', 100000, 100, 'other'),
            (1, 'page_view', '/before', 50000, 90, 'before'),
        ]:
            ts = int(datetime(2026, 11, day, 1, tzinfo=timezone.utc).timestamp()*1000)
            self.db.execute('INSERT INTO analytics (ts,type,path,duration_ms,scroll_pct,session_id) VALUES (?,?,?,?,?,?)', (ts,kind,path,duration,scroll,browser))

    def tearDown(self):
        self.db.close()

    def test_metrics_filter_events_normalize_paths_and_exclude_invalid_values(self):
        result = {key:[dict(r) for r in self.db.execute(sql)] for key,sql in analytics.queries(7,self.now).items()}
        current = next(r for r in result['summary'] if r['period'] == 'current')
        self.assertEqual(current['views'],4)
        self.assertEqual(current['browsers'],1)
        self.assertEqual(current['duration'],20)
        self.assertEqual(current['scroll'],70)
        self.assertEqual(current['duration_samples'],2)
        page = next(r for r in result['pages'] if r['path'] == '/post')
        self.assertEqual(page['views'],2)
        self.assertEqual(page['measured'],2)
        self.assertEqual(page['duration'],20)
        previous = next(r for r in result['summary'] if r['period'] == 'previous')
        self.assertEqual(previous['views'],1)

    def test_empty_database_is_not_a_query_error(self):
        self.db.execute('DELETE FROM analytics')
        for sql in analytics.queries(30,self.now).values():
            self.assertEqual(list(self.db.execute(sql)),[])

    def add_event(self, path, agent='Mozilla/5.0', kind='page_view', day=12):
        ts = int(datetime(2026, 11, day, 2, tzinfo=timezone.utc).timestamp() * 1000)
        self.db.execute(
            'INSERT INTO analytics (ts,type,path,user_agent,duration_ms,scroll_pct) VALUES (?,?,?,?,?,?)',
            (ts, kind, path, agent, 900000, 100),
        )

    def results(self):
        return {key: [dict(row) for row in self.db.execute(sql)]
                for key, sql in analytics.queries(7, self.now).items()}

    def test_single_probes_alert_even_when_claiming_to_be_crawlers(self):
        paths = ['/app/config/', '/.env.bak', '/.git/config', '/%2Eenv',
                 '/%252eenv', '/APP/CONFIG/settings.json', '/foo/../etc/passwd']
        for path in paths:
            self.add_event(path, 'Googlebot/2.1')
        self.add_event('/.env', kind='click')
        result = self.results()
        self.assertEqual({row['path'] for row in result['alerts']}, set(paths + ['/.env']))
        self.assertTrue(all(row['events'] == 1 and row['reason'] for row in result['alerts']))
        self.assertEqual(result['security_summary'][0]['events'], len(paths) + 1)
        quality = result['traffic_quality'][0]
        self.assertEqual(quality['suspicious'], len(paths))
        self.assertEqual(quality['crawlers'], 0)  # Disjoint exclusion counts.
        self.assertEqual(next(row for row in result['summary'] if row['period'] == 'current')['views'], 4)

    def test_crawlers_are_excluded_consistently_from_every_audience_query(self):
        baseline = self.results()
        audience = ['summary', 'daily', 'pages', 'sources', 'countries', 'devices', 'campaigns']
        for agent in ['Googlebot/2.1', 'Mozilla/5.0 (compatible; bingbot/2.0)',
                      'DuckDuckBot/1.0', 'AhrefsBot/7.0', 'GPTBot/1.0']:
            self.add_event('/indexable-page', agent)
            self.add_event('/indexable-page', agent, day=1)
        result = self.results()
        for key in audience:
            self.assertEqual(result[key], baseline[key], key)
        self.assertEqual(result['traffic_quality'][0]['crawlers'], 5)
        self.assertEqual(result['alerts'], [])

    def test_ordinary_content_and_missing_agents_are_not_silently_filtered(self):
        for path in ['/blog/configuration', '/blog/robots', '/.environment', '/post?next=/.env.bak']:
            self.add_event(path)
        self.add_event('/unknown-agent', None)
        result = self.results()
        self.assertEqual(result['alerts'], [])
        self.assertEqual(result['traffic_quality'][0]['unknown_agent'], 5)
        self.assertEqual(next(row for row in result['summary'] if row['period'] == 'current')['views'], 9)

    def test_security_alerts_are_independent_of_top_page_limit(self):
        for index in range(101):
            self.add_event(f'/article-{index}')
        self.add_event('/.env.bak')
        result = self.results()
        self.assertEqual(len(result['pages']), 100)
        self.assertEqual(result['alerts'][0]['path'], '/.env.bak')
        self.assertEqual(result['security_summary'][0]['events'], 1)


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.server = HTTPServer(('127.0.0.1',0),analytics.make_handler('test',{30:{'days':30}}))
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self,path,headers=None):
        connection = HTTPConnection('127.0.0.1',self.server.server_port)
        connection.request('GET',path,headers=headers or {})
        response = connection.getresponse()
        status, body, headers = response.status,response.read(),dict(response.getheaders())
        connection.close()
        return status,body,headers

    def test_assets_and_cached_data(self):
        status,body,headers = self.request('/')
        self.assertEqual(status,200)
        self.assertIn(b'Analytics overview',body)
        self.assertIn("frame-ancestors 'none'",headers['Content-Security-Policy'])
        self.assertEqual(headers['Cache-Control'],'no-store')
        self.assertEqual(json.loads(self.request('/api/data')[1]),{'days':30})

    def test_no_rebinding_cross_origin_or_arbitrary_files(self):
        self.assertEqual(self.request('/',{'Host':'attacker.example'})[0],403)
        self.assertEqual(self.request('/',{'Origin':'https://attacker.example'})[0],403)
        self.assertEqual(self.request('/',{'Sec-Fetch-Site':'cross-site'})[0],403)
        self.assertEqual(self.request('/../wrangler.jsonc')[0],404)
        self.assertEqual(self.request('/api/data?days=999')[0],400)
        self.assertEqual(self.request('/api/data?days=1%3BDROP')[0],400)

    def test_failure_is_visible_and_does_not_replace_cached_data(self):
        with patch.object(analytics,'collect',side_effect=RuntimeError('Connection failed')):
            status,body,_ = self.request('/api/data?refresh=1')
        self.assertEqual(status,502)
        self.assertEqual(json.loads(body)['error'],'Connection failed')
        self.assertEqual(self.request('/api/data')[0],200)


if __name__ == '__main__':
    unittest.main()
