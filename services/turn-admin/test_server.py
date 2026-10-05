import base64
import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch, Mock

from server import Coturn, create_server, parse_sessions

LISTING = """
    1) id=000000000000000123, user <android>:
      started 4 secs ago
      expiring in 116 secs
      client protocol UDP, relay protocol UDP
      client addr 10.0.0.7:50000, server addr 10.0.0.1:39004
      relay addr 10.0.0.1:39006
      usage: rp=4, rb=100, sp=5, sb=200
       rate: r=1, s=2, total=3 (bytes per sec)
  Total sessions: 1
> """
PASSWORD = "private-test-password-at-least-24"


class SessionsTest(unittest.TestCase):
    def test_real_cli_fields_and_string_id(self):
        session, = parse_sessions(LISTING)
        self.assertEqual(session["id"], "000000000000000123")
        self.assertEqual(session["relays"], ["10.0.0.1:39006"])
        self.assertEqual(session["client"], "10.0.0.7:50000")
        self.assertEqual(session["expiresSeconds"], "116")

    def test_unavailable_or_truncated_output_is_not_an_empty_pool(self):
        for text in ("Error", LISTING.replace("Total sessions: 1", "Total sessions: 2")):
            with self.assertRaises(RuntimeError): parse_sessions(text)
        self.assertEqual(parse_sessions("Total sessions: 0\n> "), [])

    def test_release_only_selected_session_and_verify_absence(self):
        client = Coturn("localhost", 5766, PASSWORD)
        client.command = Mock(side_effect=[LISTING, "> ", "Total sessions: 0\n> "])
        client.release("000000000000000123")
        self.assertEqual([call.args[0] for call in client.command.call_args_list],
                         ["ps", "cs 000000000000000123", "ps"])

    def test_invalid_and_expired_ids_cannot_send_cancel(self):
        client = Coturn("localhost", 5766, PASSWORD)
        client.command = Mock(return_value="Total sessions: 0\n> ")
        with self.assertRaises(ValueError): client.release("1\r\nshutdown")
        client.command.assert_not_called()
        with self.assertRaises(LookupError): client.release("123")
        client.command.assert_called_once_with("ps")


class HTTPTest(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, TURN_ADMIN_ENABLED="true", TURN_ADMIN_PASSWORD=PASSWORD)
        self.environment.start()
        self.server = create_server(port=0)
        self.server.coturn = Mock()
        self.server.coturn.sessions.return_value = parse_sessions(LISTING)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.environment.stop()

    def request(self, path, data=None, auth=True, control=False):
        headers = {}
        if auth: headers["Authorization"] = "Basic " + base64.b64encode(("admin:" + PASSWORD).encode()).decode()
        if control: headers["X-Turn-Control"] = "release"
        request = urllib.request.Request(self.url + path, data=data, headers=headers)
        return urllib.request.urlopen(request, timeout=3)

    def test_feature_disabled_hides_page_and_control(self):
        self.server.enabled = False
        for path, data in (("/", None), ("/api/status", None), ("/api/release", b'{}')):
            with self.assertRaises(urllib.error.HTTPError) as error: self.request(path, data)
            self.assertEqual(error.exception.code, 404)
        self.server.coturn.release.assert_not_called()

    def test_authentication_required_for_assets_and_control(self):
        for path, data in (("/", None), ("/app.js", None), ("/api/status", None), ("/api/release", b'{}')):
            with self.assertRaises(urllib.error.HTTPError) as error: self.request(path, data, auth=False)
            self.assertEqual(error.exception.code, 401)
        self.server.coturn.release.assert_not_called()

    def test_release_requires_control_header_and_valid_json(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/api/release", b'{"sessionId":"123"}')
        self.assertEqual(error.exception.code, 403)
        self.server.coturn.release.assert_not_called()
        with self.request("/api/release", b'{"sessionId":"123"}', control=True) as response:
            self.assertTrue(json.load(response)["released"])
        self.server.coturn.release.assert_called_once_with("123")

    def test_backend_failure_never_reports_release_success(self):
        self.server.coturn.release.side_effect = RuntimeError("Coturn unavailable")
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/api/release", b'{"sessionId":"123"}', control=True)
        self.assertEqual(error.exception.code, 502)

    def test_short_password_rejected_when_enabled(self):
        with patch.dict(os.environ, TURN_ADMIN_PASSWORD="short"):
            with self.assertRaises(ValueError): create_server(port=0)


if __name__ == "__main__": unittest.main()
