"""Streaming assistant events with fake retrieval and LLM backends."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fastapi.testclient import TestClient  # noqa: E402

from serve.api import NO_EVIDENCE, AssistantService, create_app  # noqa: E402
from serve.llm import ServeConfig  # noqa: E402

PARENT = {"parent_id": "G-10-2023::5#1::p1", "doc_id": "G-10-2023",
          "heading_path": "5 운반차량의 운행", "text": "운반차량은 제한속도를 지켜야 한다.", "score": 0.9}


class FakeStream:
    def __init__(self, pieces):
        self.pieces = pieces
        self.model = "EXAONE4.5"
        self.closed = False

    def __iter__(self):
        yield from self.pieces

    def close(self):
        self.closed = True


def service_with(stream, retrieve=None):
    streams = []

    def open_stream(messages, temperature, max_tokens):
        streams.append(stream)
        return stream

    service = AssistantService(ServeConfig(), retrieve or (lambda query, top_k: [PARENT]),
                               lambda *args: ("", ""), open_stream=open_stream)
    return service, streams


class AssistantStreamTests(unittest.TestCase):
    def test_events_meta_deltas_done_and_text_reassembles(self):
        pieces = ["운반차량은 ", "제한속도를 ", "지켜야 합니다 [S1]. ", "통로를 분리합니다 [S1]."]
        service, streams = service_with(FakeStream(pieces))
        events = list(service.stream_events("속도?", "qa", "현황", 3))
        self.assertEqual(events[0]["type"], "meta")
        self.assertEqual(events[0]["sources"][0]["doc_id"], "G-10-2023")
        self.assertEqual(events[0]["model"], "EXAONE4.5")
        self.assertEqual(events[-1]["type"], "done")
        text = "".join(event["text"] for event in events if event["type"] == "delta")
        self.assertEqual(text, "".join(pieces))
        self.assertTrue(streams[0].closed)

    def test_trailing_no_evidence_sentence_is_not_streamed(self):
        pieces = ["통로를 분리합니다 [S1].", "\n\n", NO_EVIDENCE, "."]
        service, _ = service_with(FakeStream(pieces))
        events = list(service.stream_events("q", "qa", "", 3))
        text = "".join(event["text"] for event in events if event["type"] == "delta")
        self.assertEqual(text, "통로를 분리합니다 [S1].")

    def test_closing_the_consumer_closes_the_llm_stream(self):
        stream = FakeStream(["가" * 200, "나" * 200, "다" * 200])
        service, _ = service_with(stream)
        events = service.stream_events("q", "qa", "", 3)
        self.assertEqual(next(events)["type"], "meta")
        self.assertEqual(next(events)["type"], "delta")
        events.close()  # the client went away
        self.assertTrue(stream.closed)

    def test_cancel_flag_ends_the_answer_and_closes_the_llm_stream(self):
        import threading

        stream = FakeStream(["가" * 200, "나" * 200, "다" * 200])
        service, _ = service_with(stream)
        cancel = threading.Event()
        events = service.stream_events("q", "qa", "", 3, None, cancel)
        self.assertEqual(next(events)["type"], "meta")
        self.assertEqual(next(events)["type"], "delta")
        cancel.set()  # the HTTP client disconnected
        self.assertEqual(list(events), [])
        self.assertTrue(stream.closed)

    def test_open_failure_is_an_error_event(self):
        def failing(*_args):
            raise RuntimeError("all chat LLM endpoints failed")

        service = AssistantService(ServeConfig(), lambda q, k: [PARENT], lambda *a: ("", ""), open_stream=failing)
        self.assertEqual(list(service.stream_events("q", "qa", "", 3)),
                         [{"type": "error", "code": "ASSISTANT_UNAVAILABLE", "message": "all chat LLM endpoints failed"}])

    def test_endpoint_streams_ndjson(self):
        service, _ = service_with(FakeStream(["답변 [S1]"]))
        response = TestClient(create_app(service)).post("/v1/assistant/stream", json={"question": "q"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("application/x-ndjson"))
        events = [json.loads(line) for line in response.text.splitlines() if line]
        self.assertEqual([event["type"] for event in events], ["meta", "delta", "done"])
        self.assertEqual(events[1]["text"], "답변 [S1]")


if __name__ == "__main__":
    unittest.main()
