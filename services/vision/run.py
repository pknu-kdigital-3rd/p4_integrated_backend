"""Run the app via uvicorn's API instead of its CLI, so shutdown behavior is
defined here in source rather than a launch-time flag someone has to
remember to pass every time. Without a small timeout_graceful_shutdown,
uvicorn waits indefinitely for open connections to close before it'll even
start the app's own shutdown - and /ws/playback is a long-lived WebSocket
that never closes on its own, so a plain Ctrl+C would hang until forced.
"""
import argparse
import datetime
import ipaddress
import os
import socket
from pathlib import Path

import uvicorn

from app.core.settings import BASE_DIR, settings
from app.main import app

# Deliberately a small nonzero value, not 0: with exactly 0,
# asyncio.wait_for never lets uvicorn's "wait for connections to close" check
# run far enough to notice there's nothing to wait for, so it unconditionally
# logs "Cancel 0 running task(s)" at ERROR level on every shutdown - even the
# common case where nothing needed forcing. 0.1s is imperceptible to a human
# but long enough for that check to complete normally when there's nothing
# open, while still forcing a genuinely stuck connection (like an open
# /ws/playback session) closed almost immediately. Verified both cases
# directly: 0 open connections shuts down in ~0.09s with no ERROR log; one
# stuck WebSocket still forces closed in ~0.2s, with that ERROR log now
# correctly reflecting something actually being cancelled.
_GRACEFUL_SHUTDOWN_TIMEOUT_S = 0.1


def ensure_tls_certificates(cert_path: Path, key_path: Path) -> tuple[str, str]:
    """Generate a long-lived self-signed certificate for local/P2P use."""
    if cert_path.exists() and key_path.exists():
        return str(cert_path), str(key_path)

    cert_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.parent.mkdir(parents=True, exist_ok=True)

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    san_entries: list[x509.GeneralName] = [
        x509.DNSName("localhost"),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
        x509.IPAddress(ipaddress.IPv4Address("0.0.0.0")),
    ]

    # Include the machine name and resolved addresses so a browser on the
    # local network can use the generated certificate after accepting it.
    try:
        hostname = socket.gethostname()
        san_entries.append(x509.DNSName(hostname))
        for ip in socket.gethostbyname_ex(hostname)[2]:
            try:
                san_entries.append(x509.IPAddress(ipaddress.ip_address(ip)))
            except ValueError:
                pass
    except OSError:
        pass

    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .sign(private_key, hashes.SHA256())
    )

    key_path.write_bytes(
        private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    print(f"Generated self-signed TLS certificate at {cert_path}")
    return str(cert_path), str(key_path)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the WebRTC relay server.")
    parser.add_argument(
        "--tls",
        dest="tls",
        action=argparse.BooleanOptionalAction,
        default=os.getenv("TLS_ENABLED", "false").lower() not in {"false", "0", "no"},
        help="Serve over HTTPS/TLS (default: disabled; terminate TLS at the ingress)",
    )
    parser.add_argument(
        "--tls-cert",
        default=os.getenv("TLS_CERT_FILE"),
        help="Path to a TLS certificate PEM file",
    )
    parser.add_argument(
        "--tls-key",
        default=os.getenv("TLS_KEY_FILE"),
        help="Path to a TLS private key PEM file",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    tls = {}
    if args.tls:
        cert_file = args.tls_cert or settings.TLS_CERT_FILE
        key_file = args.tls_key or settings.TLS_KEY_FILE
        if bool(cert_file) != bool(key_file):
            raise RuntimeError("TLS cert and key must be supplied together")
        if not cert_file or not key_file:
            cert_file, key_file = ensure_tls_certificates(
                BASE_DIR / "certs" / "poc-cert.pem",
                BASE_DIR / "certs" / "poc-key.pem",
            )

        settings.TLS_CERT_FILE = cert_file
        settings.TLS_KEY_FILE = key_file
        os.environ["TLS_CERT_FILE"] = cert_file
        os.environ["TLS_KEY_FILE"] = key_file
        tls = {
            "ssl_certfile": cert_file,
            "ssl_keyfile": key_file,
        }
        print(
            f"Serving HTTPS on https://{settings.HOST}:{settings.PORT} "
            "(WebCodecs secure context enabled)"
        )
    else:
        settings.TLS_CERT_FILE = None
        settings.TLS_KEY_FILE = None
        os.environ.pop("TLS_CERT_FILE", None)
        os.environ.pop("TLS_KEY_FILE", None)
        print(
            f"WARNING: Serving on plain HTTP (http://{settings.HOST}:{settings.PORT}). "
            "Remote browser WebCodecs requires HTTPS."
        )
    config = uvicorn.Config(
        app,
        host=settings.HOST,
        port=settings.PORT,
        proxy_headers=True,
        forwarded_allow_ips=settings.FORWARDED_ALLOW_IPS,
        timeout_graceful_shutdown=_GRACEFUL_SHUTDOWN_TIMEOUT_S,
        **tls,
    )
    try:
        uvicorn.Server(config).run()
    except KeyboardInterrupt:
        # Matches uvicorn's own CLI (uvicorn.main.run()): asyncio.run()'s
        # Runner (Python 3.11+) re-raises KeyboardInterrupt after cancelling
        # the main task on Ctrl+C, even though uvicorn's own signal handling
        # already shut the server down cleanly first - without this, that
        # KeyboardInterrupt reaches here uncaught and prints a full traceback
        # for a perfectly normal, successful shutdown.
        pass


if __name__ == "__main__":
    main()
