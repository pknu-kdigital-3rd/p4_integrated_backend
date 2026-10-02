"""Assistant API tests with fake retrieval and LLM backends.

Run: uv run python -m unittest discover -s tests
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fastapi.testclient import TestClient  # noqa: E402

from serve.api import AssistantService, create_app, strip_trailing_no_evidence  # noqa: E402
from serve.llm import ServeConfig  # noqa: E402

PARENT = {"parent_id": "G-10-2023::5#1::p1", "doc_id": "G-10-2023",
          "heading_path": "5 운반차량의 운행", "text": "운반차량은 제한속도를 지켜야 한다.",
          "source_relpath": "G-10-2023 작업장 내 운반차량의 운행에 관한 안전지침.pdf", "score": 0.9}


class FakeBackends:
    def __init__(self, fail_retrieval=False):
        self.fail_retrieval = fail_retrieval
        self.queries, self.messages = [], []

    def retrieve(self, query, top_k):
        self.queries.append((query, top_k))
        if self.fail_retrieval:
            raise RuntimeError("qdrant down")
        return [PARENT]

    def complete(self, messages, temperature, max_tokens):
        self.messages.append(messages)
        return "답변 [S1]", "EXAONE4.5"


def client_for(backends):
    service = AssistantService(ServeConfig(context_max_chars=4000), backends.retrieve, backends.complete,
                               lambda: {"collection": "its-kosha-transport"})
    return TestClient(create_app(service))


class AssistantApiTests(unittest.TestCase):
    def test_answer_combines_live_context_and_guides(self):
        backends = FakeBackends()
        response = client_for(backends).post("/v1/assistant/chat", json={
            "question": "정지한 차량이 있나요?", "live_context": "가상 차량 3대 중 1대 NO_ROUTE", "top_k": 3})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["answer"], "답변 [S1]")
        self.assertEqual(body["sources"][0]["doc_id"], "G-10-2023")
        self.assertIsNone(body["retrieval_error"])
        self.assertEqual(backends.queries, [("정지한 차량이 있나요?", 3)])
        user = backends.messages[0][1]["content"]
        self.assertIn("실시간 차량 현황:\n가상 차량 3대 중 1대 NO_ROUTE", user)
        self.assertIn("[S1] 5 운반차량의 운행", user)
        self.assertIn("ITS", backends.messages[0][0]["content"])

    def test_report_mode_uses_the_report_prompt_and_retrieval_query(self):
        backends = FakeBackends()
        client_for(backends).post("/v1/assistant/chat", json={
            "question": "현황 보고서", "mode": "report", "retrieval_query": "운반차량 운행 안전"})
        self.assertEqual(backends.queries[0][0], "운반차량 운행 안전")
        self.assertIn("보고서", backends.messages[0][0]["content"])

    def test_retrieval_failure_still_answers_from_live_data(self):
        backends = FakeBackends(fail_retrieval=True)
        body = client_for(backends).post("/v1/assistant/chat", json={"question": "현황은?"}).json()
        self.assertEqual(body["retrieval_error"], "qdrant down")
        self.assertEqual(body["sources"], [])
        self.assertIn("(검색된 안전 지침이 없습니다)", backends.messages[0][1]["content"])

    def test_invalid_requests_are_rejected(self):
        client = client_for(FakeBackends())
        self.assertEqual(client.post("/v1/assistant/chat", json={"question": ""}).status_code, 422)
        self.assertEqual(client.post("/v1/assistant/chat", json={"question": "q", "mode": "x"}).status_code, 422)
        self.assertEqual(client.post("/v1/assistant/chat", json={"question": "q", "top_k": 50}).status_code, 422)

    def test_llm_failure_is_a_503(self):
        backends = FakeBackends()

        def failing(*_args):
            raise RuntimeError("all chat LLM endpoints failed")

        service = AssistantService(ServeConfig(), backends.retrieve, failing)
        response = TestClient(create_app(service)).post("/v1/assistant/chat", json={"question": "q"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "ASSISTANT_UNAVAILABLE")

    def test_trailing_no_evidence_sentence_is_dropped_after_a_grounded_answer(self):
        grounded = "통로를 분리합니다 [S1].\n\n제공된 현황이나 지침에서 확인할 수 없습니다."
        self.assertEqual(strip_trailing_no_evidence(grounded), "통로를 분리합니다 [S1].")
        only = "제공된 현황이나 지침에서 확인할 수 없습니다."
        self.assertEqual(strip_trailing_no_evidence(only), only)

    def test_health(self):
        body = client_for(FakeBackends()).get("/health").json()
        self.assertEqual(body, {"status": "ok", "collection": "its-kosha-transport"})


if __name__ == "__main__":
    unittest.main()
