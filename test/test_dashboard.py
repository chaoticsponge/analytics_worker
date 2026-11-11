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
