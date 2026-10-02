"""LLMRouter -- OpenAI-compatible chat client with endpoint failover.

Points at one or more vLLM (or any OpenAI-compatible) servers and returns a
whole completion, trying each configured endpoint in order.
"""
from __future__ import annotations

import logging
import os
import tomllib
from dataclasses import dataclass, fields, replace
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LLMEndpoint:
    name: str
    base_url: str
    model: str


@dataclass(frozen=True)
class ServeConfig:
    """Chat endpoint and generation settings for query-time serving."""

    endpoints: tuple[LLMEndpoint, ...] = ()
    api_key_env: str = "LLM_API_KEY"
    api_key: str = "no_key"
    timeout_seconds: float = 300.0
    max_retries: int = 1
    startup_health_check: bool = True
    temperature: float = 0.1
    max_tokens: int = 1200
    context_max_chars: int = 12000

    @classmethod
    def load(cls, path: str | Path | None = None) -> "ServeConfig":
        """Load serving settings from TOML, then ``KSERVE_*`` environment overrides.

        ``KSERVE_LLM_BASE_URL`` (with optional ``KSERVE_LLM_MODEL``) replaces the
        TOML endpoint list with one endpoint, so deployment can point at a
        different OpenAI-compatible server through the environment.
        """
        data: dict = {}
        if path is not None and Path(path).exists():
            with open(path, "rb") as fh:
                data = tomllib.load(fh).get("serve", {})

        endpoints = _parse_endpoints(data.pop("endpoints", []))
        cfg = cls()
        merged = {f.name: data[f.name] for f in fields(cls)
                  if f.name != "endpoints" and f.name in data}
        for f in fields(cls):
            env = os.environ.get(f"KSERVE_{f.name.upper()}")
            if env is not None and f.name != "endpoints":
                merged[f.name] = env
        for k, v in merged.items():
            current = getattr(cfg, k)
            if not isinstance(v, type(current)):
                merged[k] = type(current)(v)
        cfg = replace(cfg, **merged) if merged else cfg
        env_base_url = os.environ.get("KSERVE_LLM_BASE_URL", "").strip()
        if env_base_url:
            model = os.environ.get("KSERVE_LLM_MODEL", "").strip() or (endpoints[0].model if endpoints else "")
            if not model:
                raise RuntimeError("KSERVE_LLM_BASE_URL is set but no model is configured (KSERVE_LLM_MODEL)")
            endpoints = (LLMEndpoint(name=model, base_url=env_base_url, model=model),)
        return replace(cfg, endpoints=endpoints) if endpoints else cfg


def _parse_endpoints(raw: list) -> tuple[LLMEndpoint, ...]:
    """Parse valid OpenAI-compatible endpoint entries from TOML."""
    out: list[LLMEndpoint] = []
    for entry in raw or []:
        if not isinstance(entry, dict):
            continue
        base_url = entry.get("base_url")
        model = entry.get("model")
        if not base_url or not model:
            continue
        out.append(LLMEndpoint(name=entry.get("name") or model,
                               base_url=base_url, model=model))
    return tuple(out)


class LLMRouter:
    """OpenAI-compatible chat client wrapping one or more configured endpoints,
    tried in order on failure (`self.clients`, populated at construction)."""

    def __init__(self, cfg: ServeConfig) -> None:
        """Build an `OpenAI` client per `cfg.endpoints` and optionally health-check
        each one (`cfg.startup_health_check`) by listing its served models.

        Raises:
            RuntimeError: `cfg.endpoints` is empty, or every endpoint's client
                construction/health-check raised (i.e. none is usable) -- the
                individual per-endpoint errors are joined into the message.

        Note:
            A failed health check for one endpoint only excludes that endpoint
            from `self.clients`; construction only raises once *all* of them fail.
        """
        from openai import OpenAI

        if not cfg.endpoints:
            raise RuntimeError("no chat LLM endpoints configured ([[serve.endpoints]])")
        api_key = os.environ.get(cfg.api_key_env, cfg.api_key)
        self.clients: list[tuple[str, object, str]] = []
        errors: list[str] = []
        for ep in cfg.endpoints:
            try:
                client = OpenAI(base_url=ep.base_url, api_key=api_key,
                                timeout=cfg.timeout_seconds, max_retries=cfg.max_retries)
                if cfg.startup_health_check:
                    listed = client.models.list().data
                    served = next((m for m in listed if m.id == ep.model), None)
                    logger.info("LLM endpoint ready: endpoint=%s configured_model=%s served_root=%s",
                                ep.name, ep.model, getattr(served, "root", None))
                self.clients.append((ep.name, client, ep.model))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{ep.name}: {exc}")
        if not self.clients:
            raise RuntimeError("no chat LLM endpoint is reachable: " + " | ".join(errors))

    def stream(self, messages: list[dict], temperature: float,
               max_tokens: int) -> "TextStream":
        """Open a streaming completion on the first endpoint that accepts it.

        Failover only happens before any text is produced; once a stream is
        open, its errors surface to the caller.
        """
        errors: list[str] = []
        for name, client, model in self.clients:
            try:
                response = client.chat.completions.create(
                    model=model, messages=messages, stream=True,
                    temperature=temperature, max_tokens=max_tokens,
                    extra_body={"chat_template_kwargs": {"enable_thinking": False}})
                return TextStream(response, model)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{name}: {exc}")
        raise RuntimeError("all chat LLM endpoints failed: " + " | ".join(errors))

    def complete(self, messages: list[dict], temperature: float,
                 max_tokens: int) -> tuple[str, str]:
        """Return `(answer, model)` from the first endpoint that answers."""
        errors: list[str] = []
        for name, client, model in self.clients:
            try:
                resp = client.chat.completions.create(
                    model=model, messages=messages,
                    temperature=temperature, max_tokens=max_tokens,
                    extra_body={"chat_template_kwargs": {"enable_thinking": False}})
                text = (resp.choices[0].message.content or "").strip()
                if not text:
                    raise RuntimeError("empty response")
                return text, model
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{name}: {exc}")
        raise RuntimeError("all chat LLM endpoints failed: " + " | ".join(errors))


class TextStream:
    """Iterate the text deltas of an OpenAI-compatible streaming completion.

    ``close()`` closes the HTTP response, which makes the server stop
    generating; call it when the consumer goes away.
    """

    def __init__(self, response, model: str) -> None:
        self._response = response
        self.model = model

    def __iter__(self):
        for chunk in self._response:
            choices = getattr(chunk, "choices", None) or []
            delta = getattr(choices[0], "delta", None) if choices else None
            text = getattr(delta, "content", None) if delta is not None else None
            if text:
                yield text

    def close(self) -> None:
        close = getattr(self._response, "close", None)
        if close is not None:
            close()
