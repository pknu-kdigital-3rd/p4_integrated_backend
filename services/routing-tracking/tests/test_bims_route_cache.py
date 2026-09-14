import copy
import io
import json
from pathlib import Path
import shutil
from uuid import uuid4
import unittest
from unittest.mock import patch
import urllib.error

import bims_client as client
import build_bims_route_cache as builder


def static_stop(ars="08235", node="509130000", **extra):
    return {"arsno": ars, "bstopid": node, "bstopnm": "금곡역",
            "gpsx": "129.01", "gpsy": "35.25", **extra}


def catalog(*stops):
    return {"version": 1, "complete": True, "source": builder.STOP_ENDPOINT,
            "generated_at_utc": "2026-09-11T00:00:00Z", "total_count": len(stops), "stops": list(stops)}


def routes():
    return {"126": {"line_number": "126", "line_id": "5200126000", "turnaround_stop_index": 2,
                    "stops": [
                        {"stop_index": 2, "ars_number": "08236", "node_id": "509150000",
                         "direction": "inbound", "latitude": 36.0, "longitude": 130.0},
                        {"stop_index": 1, "ars_number": "08235", "node_id": "509130000",
                         "direction": "outbound", "latitude": 36.0, "longitude": 130.0}]}}


def page(number, total, *stops):
    return {"response": {"header": {"resultCode": "00"}, "body": {
        "pageNo": number, "totalCount": total, "numOfRows": 1, "items": {"item": list(stops)}}}}


def xml_page(number, total, stop):
    fields = "".join(f"<{key}>{value}</{key}>" for key, value in stop.items())
    return (f'<response xmlns="urn:test"><header><resultCode>00</resultCode></header>'
            f'<body><pageNo>{number}</pageNo><totalCount>{total}</totalCount><numOfRows>1</numOfRows>'
            f'<items><item>{fields}</item></items></body></response>').encode()


class MatchingTests(unittest.TestCase):
    def test_preserves_metadata_orders_stops_and_uses_only_static_coordinates(self):
        original = routes()
        before = copy.deepcopy(original)
        result, report = builder.enrich_routes(original, catalog(
            static_stop(ars=8235), static_stop("08236", "509150000")))
        stops = result["routes"]["126"]["stops"]
        self.assertEqual([s["stop_index"] for s in stops], [1, 2])
        self.assertEqual(stops[0]["ars_number"], "08235")
        self.assertEqual(stops[0]["stop_lat"], 35.25)
        self.assertEqual(stops[0]["latitude"], 36.0)
        self.assertEqual(stops[0]["coordinate_source"], "busStopList")
        self.assertEqual(result["routes"]["126"]["turnaround_stop_index"], 2)
        self.assertEqual(original, before)
        self.assertTrue(report["complete"])

    def test_missing_ars_uses_exact_node_id(self):
        data = routes()
        data["126"]["stops"][1]["ars_number"] = None
        result, _ = builder.enrich_routes(data, catalog(static_stop()))
        self.assertEqual(result["routes"]["126"]["stops"][0]["coordinate_match"], "node_id")

    def test_ambiguous_and_missing_identifiers_reported_without_guessing(self):
        data = routes()
        data["126"]["stops"][1]["node_id"] = ""
        result, report = builder.enrich_routes(data, catalog(static_stop(), static_stop(node="other")))
        self.assertIsNone(result["routes"]["126"]["stops"][0]["stop_lat"])
        self.assertEqual([s["reason"] for s in report["lines"]["126"]["unresolved_stops"]],
                         ["ambiguous_match", "not_found"])

    def test_node_conflict_does_not_accept_ars_match(self):
        _, report = builder.enrich_routes(routes(), catalog(static_stop(node="wrong")))
        self.assertEqual(report["lines"]["126"]["unresolved_stops"][0]["reason"], "identifier_conflict")

    def test_duplicate_ars_disambiguated_by_node_id(self):
        result, _ = builder.enrich_routes(routes(), catalog(static_stop(), static_stop(node="other")))
        self.assertEqual(result["routes"]["126"]["stops"][0]["stop_lat"], 35.25)

    def test_invalid_static_coordinates_never_fall_back_to_live_fields(self):
        for value in (None, "NaN", "Infinity", "91", "0", "invalid"):
            with self.subTest(value=value):
                result, report = builder.enrich_routes(routes(), catalog(static_stop(gpsy=value, lat=35, lin=129)))
                self.assertIsNone(result["routes"]["126"]["stops"][0]["stop_lat"])
                self.assertEqual(report["lines"]["126"]["unresolved_stops"][0]["reason"],
                                 "invalid_static_coordinates")


class ApiTests(unittest.TestCase):
    @patch("build_bims_route_cache.time.sleep")
    def test_json_and_xml_pagination(self, sleep):
        for encoding in ("json", "xml"):
            first, second = static_stop(), static_stop("08236", "509150000")
            payloads = ([json.dumps(page(1, 2, first)).encode(), json.dumps(page(2, 2, second)).encode()]
                        if encoding == "json" else [xml_page(1, 2, first), xml_page(2, 2, second)])
            with self.subTest(encoding=encoding), patch("bims_client.urllib.request.urlopen",
                    side_effect=[io.BytesIO(raw) for raw in payloads]) as request, patch("builtins.print"):
                result = builder.download_catalog("fixture-key", page_size=1)
                self.assertEqual(result["total_count"], 2)
                self.assertEqual(len(result["stops"]), 2)
                self.assertIn("pageNo=2", request.call_args.args[0].full_url)
                self.assertTrue(all("busStopList?" in call.args[0].full_url for call in request.call_args_list))

    def test_bad_pagination_never_returns_complete_catalog(self):
        first = page(1, 3, static_stop())
        for second in (page(1, 3, static_stop("08236", "other")), page(2, 3, static_stop()),
                       page(2, 4, static_stop("08236", "other")), page(2, 3)):
            with self.subTest(second=second), patch("build_bims_route_cache._request_json",
                    side_effect=[first, second]), patch("build_bims_route_cache.time.sleep"), patch("builtins.print"):
                with self.assertRaises(client.BimsApiError):
                    builder.download_catalog("fixture-key", page_size=1)

    def test_auth_and_quota_fail_immediately_in_http_200(self):
        for code, exception in (("22", client.BimsQuotaExceededError), ("30", client.BimsAuthenticationError)):
            payloads = [json.dumps({"response": {"header": {"resultCode": code}}}).encode(),
                        (f"<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>{code}</returnReasonCode>"
                         "<returnAuthMsg>ERROR</returnAuthMsg></cmmMsgHeader></OpenAPI_ServiceResponse>").encode()]
            for raw in payloads:
                with self.subTest(code=code, raw=raw), patch("bims_client.urllib.request.urlopen",
                        return_value=io.BytesIO(raw)) as request, patch("bims_client.time.sleep") as sleep:
                    with self.assertRaises(exception):
                        client._request_json(builder.STOP_ENDPOINT, "fixture-key", {}, timeout=1, retries=2)
                    self.assertEqual(request.call_count, 1)
                    sleep.assert_not_called()

    def test_overlapping_pages_are_not_counted_as_complete(self):
        first, second, third = static_stop(), static_stop("08236", "second"), static_stop("08237", "third")
        with patch("build_bims_route_cache._request_json", side_effect=[
                page(1, 4, first, second), page(2, 4, second, third)]), \
                patch("build_bims_route_cache.time.sleep"), patch("builtins.print"):
            with self.assertRaises(client.BimsApiError):
                builder.download_catalog("fixture-key", page_size=2)

    def test_http_gateway_quota_error_is_terminal(self):
        error = urllib.error.HTTPError(builder.STOP_ENDPOINT, 500, "error", {}, io.BytesIO(
            b"<error><returnReasonCode>22</returnReasonCode></error>"))
        with patch("bims_client.urllib.request.urlopen", side_effect=error) as request:
            with self.assertRaises(client.BimsQuotaExceededError):
                client._request_json(builder.STOP_ENDPOINT, "fixture-key", {}, timeout=1, retries=2)
            self.assertEqual(request.call_count, 1)

    def test_transient_failure_has_bounded_retries(self):
        with patch("bims_client.urllib.request.urlopen", side_effect=urllib.error.URLError("offline")) as request, \
                patch("bims_client.time.sleep") as sleep:
            with self.assertRaises(client.BimsApiError):
                client._request_json(builder.STOP_ENDPOINT, "fixture-key", {}, timeout=1, retries=2)
            self.assertEqual(request.call_count, 3)
            self.assertEqual(sleep.call_count, 2)


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).parent / ("bims-cache-test-" + uuid4().hex)
        self.root.mkdir()
        self.addCleanup(shutil.rmtree, self.root)
        self.input = self.root / "routes.json"
        self.output = self.root / "bims_route_cache.json"
        self.stop_path = self.root / "bims_stop_catalog.json"
        builder.write_json(self.input, {"routes": routes()})
        self.args = ["--routes", str(self.input), "--output", str(self.output), "--lines", "126"]
        printer = patch("builtins.print")
        self.print_mock = printer.start()
        self.addCleanup(printer.stop)
        environment = patch.dict("os.environ", {"BUSAN_BIMS_SERVICE_KEY": ""})
        environment.start()
        self.addCleanup(environment.stop)

    def save_catalog(self):
        builder.write_json(self.stop_path, catalog(static_stop(), static_stop("08236", "509150000")))

    def test_offline_and_cached_runs_make_zero_requests(self):
        self.save_catalog()
        for extra in (["--offline"], []):
            with patch("bims_client.urllib.request.urlopen") as request:
                self.assertEqual(builder.main(self.args + extra), 0)
                request.assert_not_called()
        self.assertTrue(builder.read_json(self.output)["complete"])

    def test_offline_without_catalog_and_missing_key_fail_without_requests(self):
        for extra in (["--offline"], []):
            with patch("bims_client.urllib.request.urlopen") as request:
                self.assertEqual(builder.main(self.args + extra), 1)
                request.assert_not_called()
                self.assertFalse(self.output.exists())

    def test_unresolved_stops_produce_partial_cache_report_and_exit_two(self):
        builder.write_json(self.stop_path, catalog(static_stop()))
        self.assertEqual(builder.main(self.args + ["--offline"]), 2)
        self.assertFalse(builder.read_json(self.output)["complete"])
        report = builder.read_json(self.root / "bims_route_cache_report.json")
        self.assertEqual(report["unresolved_count"], 1)

    def test_refresh_failure_preserves_previous_outputs(self):
        self.save_catalog()
        self.assertEqual(builder.main(self.args), 0)
        files = [self.output, self.stop_path, self.root / "bims_route_cache_report.json"]
        before = [path.read_bytes() for path in files]
        with patch.dict("os.environ", {"BUSAN_BIMS_SERVICE_KEY": "fixture-key"}), \
                patch("build_bims_route_cache._request_json", side_effect=client.BimsQuotaExceededError("quota")):
            self.assertEqual(builder.main(self.args + ["--refresh"]), 1)
        self.assertEqual([path.read_bytes() for path in files], before)

    def test_fresh_download_writes_reusable_catalog(self):
        with patch.dict("os.environ", {"BUSAN_BIMS_SERVICE_KEY": "fixture-key"}), \
                patch("build_bims_route_cache._request_json", return_value=page(
                    1, 2, static_stop(), static_stop("08236", "509150000"))):
            self.assertEqual(builder.main(self.args), 0)
        self.assertTrue(builder.read_json(self.stop_path)["complete"])

    def test_malformed_routes_fail_before_network(self):
        data = routes()
        data["126"]["stops"][1]["stop_index"] = 2
        builder.write_json(self.input, {"routes": data})
        with patch("bims_client.urllib.request.urlopen") as request:
            self.assertEqual(builder.main(self.args), 1)
            request.assert_not_called()

    def test_output_cannot_overwrite_input(self):
        before = self.input.read_bytes()
        self.assertEqual(builder.main(self.args + ["--output", str(self.input)]), 1)
        self.assertEqual(self.input.read_bytes(), before)

    def test_failed_atomic_write_preserves_existing_file(self):
        self.save_catalog()
        before = self.stop_path.read_bytes()
        with self.assertRaises(ValueError):
            builder.write_json(self.stop_path, {"invalid": float("nan")})
        self.assertEqual(self.stop_path.read_bytes(), before)
        self.assertFalse(list(self.root.glob("*.tmp")))

    def test_failure_redacts_service_key(self):
        with patch.dict("os.environ", {"BUSAN_BIMS_SERVICE_KEY": "fixture-secret"}), \
                patch("build_bims_route_cache._request_json", side_effect=client.BimsApiError("fixture-secret")):
            self.assertEqual(builder.main(self.args), 1)
        self.assertNotIn("fixture-secret", str(self.print_mock.call_args_list))

    def test_incomplete_saved_catalog_is_rejected_offline(self):
        data = catalog(static_stop())
        data["complete"] = False
        builder.write_json(self.stop_path, data)
        with patch("bims_client.urllib.request.urlopen") as request:
            self.assertEqual(builder.main(self.args + ["--offline"]), 1)
            request.assert_not_called()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
