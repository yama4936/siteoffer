"""Reserved domains and explicitly synthetic values; no network or database access."""

import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from validate_candidates import validate, valid_number


def candidate():
    return {
        "name": "検証用サンプル",
        "corporate_number": None,
        "prefecture": "愛知県",
        "city": "名古屋市",
        "address": "愛知県名古屋市 試験用住所",
        "address_source_url": "https://company.example/company/",
        "industry": "試験用業種",
        "representative_phone": None,
        "found_via": {"url": "https://directory.example/list", "note": "検証用出典"},
        "fetched_at": "2026-10-28T10:30:00+09:00",
        "official_site": {
            "url": "https://company.example/",
            "evidence_url": "https://company.example/company/",
            "evidence": {"company_name": "検証用サンプル", "address": None, "corporate_number": None},
        },
        "other_sites": [],
        "size_check": {"listed": None, "franchise_or_branch": None, "capital": None,
                       "employees": None, "source_url": None, "note": "試験用のため規模は不明"},
    }


def document():
    return {"criteria": {"prefecture": "愛知県", "city": "名古屋市", "industry": "試験用業種", "keywords": []},
            "run": {"started_at": "2026-10-28T10:00:00+09:00", "model": "不明"},
            "candidates": [candidate()], "excluded": []}


class ValidationTests(unittest.TestCase):
    def test_valid_input_does_not_change_data(self):
        data = document()
        before = copy.deepcopy(data)
        self.assertEqual(validate(data), {"ok": True, "errors": [], "warnings": []})
        self.assertEqual(data, before)

    def test_unknown_size_is_preserved_and_not_an_exclusion(self):
        data = document()
        data["candidates"][0]["size_check"] = {"listed": None, "franchise_or_branch": None, "note": "公開記載なし"}
        self.assertTrue(validate(data)["ok"])

    def test_unknown_official_site_is_warning_without_inventing_officiality(self):
        data = document()
        data["candidates"][0]["official_site"] = None
        result = validate(data)
        self.assertTrue(result["ok"])
        self.assertIn("no_official_site", [w["code"] for w in result["warnings"]])

    def test_missing_address_source_blocks_claimed_location(self):
        data = document()
        data["candidates"][0]["address_source_url"] = None
        self.assertIn("missing_address_source", [e["code"] for e in validate(data)["errors"]])

    def test_area_mismatch_and_missing_prefecture(self):
        for field, value, code in (("prefecture", "岐阜県", "area_mismatch"),
                                   ("city", "豊田市", "area_mismatch"),
                                   ("prefecture", None, "city_without_prefecture")):
            with self.subTest(field=field, value=value):
                data = document()
                data["candidates"][0][field] = value
                self.assertIn(code, [e["code"] for e in validate(data)["errors"]])

    def test_criteria_are_validated_before_database_access(self):
        for criteria in ({"city": "名古屋市"}, {"cityCode": "123"}, {"keywords": [True]}, {"industry": None}):
            with self.subTest(criteria=criteria):
                data = document()
                data["criteria"] = criteria
                self.assertFalse(validate(data)["ok"])

    def test_timestamps_reject_naive_or_impossible_dates(self):
        for value in ("2026-10-28T10:00:00", "2026-02-30T10:00:00+09:00", True, None):
            with self.subTest(value=value):
                data = document()
                data["candidates"][0]["fetched_at"] = value
                self.assertIn("invalid_timestamp", [e["code"] for e in validate(data)["errors"]])

    def test_urls_reject_internal_hosts_credentials_and_schemes(self):
        for value in ("http://localhost/", "https://127.0.0.1/", "https://10.1.2.3/", "https://[::1]/",
                      "https://service.internal/", "https://user:password@company.example/", "file:///tmp/test",
                      "https://company.example:invalid/", "company.example", True):
            with self.subTest(value=value):
                data = document()
                data["candidates"][0]["found_via"]["url"] = value
                self.assertIn("invalid_public_url", [e["code"] for e in validate(data)["errors"]])

    def test_cross_domain_evidence_rejected_but_www_equivalent(self):
        data = document()
        data["candidates"][0]["official_site"]["evidence_url"] = "https://directory.example/entry"
        self.assertIn("off_site_evidence", [e["code"] for e in validate(data)["errors"]])
        data["candidates"][0]["official_site"]["evidence_url"] = "https://www.company.example/company/"
        self.assertTrue(validate(data)["ok"])

    def test_duplicate_domain_across_scheme_and_paths_is_detected(self):
        data = document()
        duplicate = candidate()
        duplicate["name"] = "別名の試験用サンプル"
        duplicate["official_site"]["url"] = "http://www.company.example/branch/?utm_source=test#fragment"
        data["candidates"].append(duplicate)
        self.assertIn("duplicate_domain", [e["code"] for e in validate(data)["errors"]])

    def test_duplicate_corporate_number_and_invalid_checksum(self):
        # Format-only synthetic number; this is not a claim that the entity exists.
        synthetic_number = "9000000000000"
        self.assertTrue(valid_number(synthetic_number))
        data = document()
        data["candidates"][0]["corporate_number"] = synthetic_number
        duplicate = candidate()
        duplicate["corporate_number"] = synthetic_number
        duplicate["official_site"] = None
        data["candidates"].append(duplicate)
        self.assertIn("duplicate_corporate_number", [e["code"] for e in validate(data)["errors"]])
        for invalid in ("1000000000000", 9000000000000, True, "９００００００００００００"):
            data = document()
            data["candidates"][0]["corporate_number"] = invalid
            self.assertIn("invalid_corporate_number", [e["code"] for e in validate(data)["errors"]])

    def test_same_name_same_city_requires_review_but_is_not_auto_merged(self):
        data = document()
        duplicate = candidate()
        duplicate["official_site"] = None
        data["candidates"].append(duplicate)
        result = validate(data)
        self.assertTrue(result["ok"])
        self.assertIn("duplicate_name_location", [w["code"] for w in result["warnings"]])

    def test_excluded_flags_and_missing_size_source(self):
        for flag in ("listed", "franchise_or_branch"):
            data = document()
            data["candidates"][0]["size_check"][flag] = True
            self.assertIn("excluded_company", [e["code"] for e in validate(data)["errors"]])
            data["candidates"][0]["size_check"][flag] = False
            self.assertIn("missing_size_source", [e["code"] for e in validate(data)["errors"]])

    def test_bad_shapes_return_errors_instead_of_crashing(self):
        for value in (None, [], 1, "text", {"criteria": [], "candidates": [None, [], {"name": []}], "excluded": [True]}):
            with self.subTest(value=value):
                self.assertFalse(validate(value)["ok"])

    def test_cli_is_read_only_and_has_machine_readable_exit_status(self):
        script = Path(__file__).with_name("validate_candidates.py")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "candidates.json"
            original = json.dumps(document(), ensure_ascii=False)
            path.write_text(original, encoding="utf-8")
            result = subprocess.run([sys.executable, str(script), str(path)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertTrue(json.loads(result.stdout)["ok"])
            self.assertEqual(path.read_text(encoding="utf-8"), original)
            for invalid in ('{"candidates":[],"candidates":[]}', '{"criteria":NaN}', "{invalid}"):
                path.write_text(invalid, encoding="utf-8")
                result = subprocess.run([sys.executable, str(script), str(path)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 1)
                self.assertFalse(json.loads(result.stdout)["ok"])
                self.assertEqual(path.read_text(encoding="utf-8"), invalid)


if __name__ == "__main__":
    unittest.main()
