import os
import unittest
from pathlib import Path
from unittest.mock import patch

from app.core.settings import settings
import run


class RunTlsTests(unittest.TestCase):
    def setUp(self):
        self._settings = {
            "cert": settings.TLS_CERT_FILE,
            "key": settings.TLS_KEY_FILE,
        }
        self._env = {
            name: os.environ.get(name)
            for name in ("TLS_ENABLED", "TLS_CERT_FILE", "TLS_KEY_FILE")
        }

    def tearDown(self):
        settings.TLS_CERT_FILE = self._settings["cert"]
        settings.TLS_KEY_FILE = self._settings["key"]
        for name, value in self._env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    def test_tls_is_disabled_by_default_for_reverse_proxy(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(run.parse_args([]).tls)

    def test_certificate_generation_is_reusable(self):
        cert = Path("cert.pem")
        key = Path("key.pem")
        with (
            patch.object(Path, "exists", side_effect=[False, True, True]),
            patch.object(Path, "mkdir"),
            patch.object(Path, "write_bytes") as write_bytes,
        ):
            first = run.ensure_tls_certificates(cert, key)
            second = run.ensure_tls_certificates(cert, key)

            self.assertEqual(first, second)
            self.assertEqual(write_bytes.call_count, 2)

    def test_main_uses_generated_tls_only_when_explicitly_enabled(self):
        with (
            patch.object(
                run,
                "ensure_tls_certificates",
                return_value=("generated-cert.pem", "generated-key.pem"),
            ) as ensure_certificates,
            patch("uvicorn.Config") as mock_config,
            patch("uvicorn.Server.run") as mock_server_run,
        ):
            run.main(["--no-tls"])  # prove the opt-out remains explicit
            self.assertIsNone(settings.TLS_CERT_FILE)
            self.assertNotIn("ssl_certfile", mock_config.call_args.kwargs)

            run.main(["--tls"])
            ensure_certificates.assert_called_once_with(
                run.BASE_DIR / "certs" / "poc-cert.pem",
                run.BASE_DIR / "certs" / "poc-key.pem",
            )
            self.assertEqual(settings.TLS_CERT_FILE, "generated-cert.pem")
            self.assertEqual(settings.TLS_KEY_FILE, "generated-key.pem")
            self.assertEqual(
                mock_config.call_args.kwargs["ssl_certfile"],
                "generated-cert.pem",
            )
            self.assertEqual(
                mock_config.call_args.kwargs["ssl_keyfile"],
                "generated-key.pem",
            )

        self.assertEqual(mock_server_run.call_count, 2)


if __name__ == "__main__":
    unittest.main()
