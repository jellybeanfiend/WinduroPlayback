import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "validate_tracks.py"
SPEC = importlib.util.spec_from_file_location("validate_tracks", SCRIPT_PATH)
validator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validator)


class ValidateRaceCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.previous_root = validator.ROOT
        self.previous_catalog_path = validator.RACE_CATALOG_PATH
        validator.ROOT = self.root
        validator.RACE_CATALOG_PATH = self.root / "races.json"

    def tearDown(self):
        validator.ROOT = self.previous_root
        validator.RACE_CATALOG_PATH = self.previous_catalog_path
        self.temporary_directory.cleanup()

    def write_race(self, race_id, tracks):
        race_directory = self.root / "tracks" / race_id
        race_directory.mkdir(parents=True, exist_ok=True)
        (race_directory / "race.json").write_text(
            json.dumps(
                {
                    "syncLine": {
                        "start": [47.5, -122.2],
                        "end": [47.5, -122.19],
                    },
                    "tracks": tracks,
                }
            ),
            encoding="utf-8",
        )
        return {
            "id": race_id,
            "name": race_id,
            "date": "2026-11-08",
            "manifest": f"./tracks/{race_id}/race.json",
        }

    def write_timed_track(self, race_id, color):
        race_directory = self.root / "tracks" / race_id
        race_directory.mkdir(parents=True, exist_ok=True)
        (race_directory / "rider.gpx").write_text(
            """<gpx><trk><trkseg>
            <trkpt lat="47.5" lon="-122.2"><time>2026-11-08T10:00:00Z</time></trkpt>
            <trkpt lat="47.6" lon="-122.2"><time>2026-11-08T10:01:00Z</time></trkpt>
            </trkseg></trk></gpx>""",
            encoding="utf-8",
        )
        return {
            "name": "Rider",
            "discipline": "Windsurf",
            "file": "rider.gpx",
            "gear": "Test gear",
            "color": color,
        }

    def run_validator(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = validator.validate()
        return result, output.getvalue()

    def test_accepts_empty_race_and_tracks_in_separate_race_folders(self):
        empty_race = self.write_race("empty-race", [])
        first_track = self.write_timed_track("first-race", "#112233")
        second_track = self.write_timed_track("second-race", "#112233")
        races = [
            empty_race,
            self.write_race("first-race", [first_track]),
            self.write_race("second-race", [second_track]),
        ]
        (self.root / "races.json").write_text(json.dumps({"races": races}), encoding="utf-8")

        result, output = self.run_validator()

        self.assertEqual(result, 0, output)
        self.assertIn("Validated 3 race(s), 2 participants", output)

    def test_rejects_invalid_race_date(self):
        race = self.write_race("bad-date", [])
        race["date"] = "2026-02-31"
        (self.root / "races.json").write_text(json.dumps({"races": [race]}), encoding="utf-8")

        result, output = self.run_validator()

        self.assertEqual(result, 1)
        self.assertIn("date must be a valid YYYY-MM-DD date", output)


if __name__ == "__main__":
    unittest.main()
