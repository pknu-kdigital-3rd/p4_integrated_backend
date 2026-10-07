"""Generate native JWT and local HTTPS keys with Vision's locked cryptography."""
from datetime import datetime, timedelta, timezone
import ipaddress
import os
from pathlib import Path
from urllib.parse import urlparse

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def write_private(path, key):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Create private files with restrictive permissions from the first write.
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as stream:
        stream.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                     serialization.NoEncryption()))
    path.chmod(0o600)


def ensure_keys(env):
    private, public = Path(env["JWT_PRIVATE_KEY_PATH"]), Path(env["JWT_PUBLIC_KEY_PATH"])
    if not private.is_file():
        write_private(private, rsa.generate_private_key(public_exponent=65537, key_size=2048))
    if not public.is_file():
        key = serialization.load_pem_private_key(private.read_bytes(), password=None)
        public.parent.mkdir(parents=True, exist_ok=True)
        public.write_bytes(key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    if env.get("NATIVE_TLS") == "false":
        return
    cert_path, key_path = Path(env["NATIVE_TLS_CERT"]), Path(env["NATIVE_TLS_KEY"])
    if cert_path.is_file() and key_path.is_file():
        return
    hostname = urlparse(env["PUBLIC_OPERATOR_URL"]).hostname
    names = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    try:
        names.append(x509.IPAddress(ipaddress.ip_address(hostname)))
    except ValueError:
        names.append(x509.DNSName(hostname))
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "p4-native")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(days=365)).add_extension(x509.SubjectAlternativeName(names), critical=False)
            .sign(key, hashes.SHA256()))
    write_private(key_path, key)
    cert_path.parent.mkdir(parents=True, exist_ok=True)
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


if __name__ == "__main__":
    ensure_keys(os.environ)
