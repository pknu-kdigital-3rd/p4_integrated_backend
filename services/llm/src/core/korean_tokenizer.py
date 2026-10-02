"""One Korean tokenization rule, shared by indexing and querying.

Kiwi morphological analysis, keeping only content morphemes (nouns, verbs,
adjectives, foreign words, numbers, adverbs) and dropping particles/endings --
so '저항값을' and '저항값' match. Falls back to a hangul/alnum regex if kiwipiepy
is unavailable. Adapted from askdori_RAG/course/src/korean_tokenizer.py.
"""
from __future__ import annotations

import re

_CONTENT_TAG_PREFIXES = (
    "NN", "NP", "NR",     # nouns
    "VV", "VA", "VX",     # verbs / adjectives
    "XR",                 # root
    "SL", "SH",           # foreign / hanja (e.g. PEN, IEC)
    "SN",                 # numbers
    "MAG",                # general adverbs
)
_KIWI = None


def tokenize(text: str) -> list[str]:
    """Tokenize Korean (or mixed) text into content-word tokens for BM25.

    Runs Kiwi morphological analysis and keeps only tokens whose POS tag
    starts with one of `_CONTENT_TAG_PREFIXES` — nouns (NN*/NP/NR), verb
    and adjective stems (VV/VA/VX), root forms (XR), foreign/hanja tokens
    (SL/SH, e.g. product codes like "PEN"), numbers (SN), and general
    adverbs (MAG). Everything else — particles (은/는/이/가/을/를/...),
    verb/adjective endings, punctuation — is dropped, so inflected forms of
    the same word match at the BM25 level (e.g. "저항값을" and "저항값"
    both tokenize to "저항값").

    Args:
        text: input text; `None`/empty is treated as `""`.

    Returns:
        Lowercased content-word tokens, in order. Falls back to a plain
        `[가-힣]+|[a-z0-9]+` regex split (no POS filtering) if `kiwipiepy`
        isn't installed, or if Kiwi tokenizes the text but every token gets
        filtered out (e.g. a query that's entirely particles/punctuation).

    Note:
        Both indexing and query-time serving
        must call this same function so the sparse vector space stays
        consistent — this is the "one Korean tokenization rule, shared by
        indexing and querying" the module docstring refers to.
    """
    global _KIWI
    try:
        if _KIWI is None:
            from kiwipiepy import Kiwi
            _KIWI = Kiwi()
        tokens = [
            tok.form.strip().lower()
            for tok in _KIWI.tokenize(text or "")
            if tok.form.strip() and tok.tag.startswith(_CONTENT_TAG_PREFIXES)
        ]
        if tokens:
            return tokens
    except ImportError:
        pass
    return re.findall(r"[가-힣]+|[a-z0-9]+", (text or "").lower())


def tokenize_to_text(text: str) -> str:
    """Space-joined tokens -- the string fed to the BM25 sparse embedder."""
    return " ".join(tokenize(text))
