import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import pages


class LiveViewPageTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(pages.router)
        self.client = TestClient(app)

    def test_page_loads_the_track_module(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn('<script src="live-view-tracks.js"></script>', response.text)

    def test_page_loads_the_distance_colors_module(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn('<script src="live-view-distance-colors.js"></script>', response.text)

    def test_track_module_is_served_as_javascript(self):
        response = self.client.get("/live-view-tracks.js")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/javascript"))
        self.assertIn("LiveViewTracks", response.text)

    def test_distance_colors_module_is_served_as_javascript(self):
        response = self.client.get("/live-view-distance-colors.js")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/javascript"))
        self.assertIn("LiveViewDistanceColors", response.text)


if __name__ == "__main__":
    unittest.main()
