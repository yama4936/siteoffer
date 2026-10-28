#!/usr/bin/env python3
"""Offline quality checks for agent-web input; never fetches URLs or changes files."""

import argparse
from datetime import datetime
import ipaddress
import json
from pathlib import Path
import re
import sys
import unicodedata
from urllib.parse import urlsplit


def valid_number(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{13}", value):
        return False
    total = sum(int(digit) * (1 if n % 2 else 2)
                for n, digit in enumerate(reversed(value[1:]), 1))
    return int(value[0]) == 9 - total % 9


def core_name(value):
    text = unicodedata.normalize("NFKC", value)
    for token in ("株式会社", "有限会社", "合同会社", "(株)", "(有)", "(同)"):
        text = text.replace(token, "")
    return re.sub(r"\s+", "", text)


def validate(data):
    errors, warnings = [], []

    def report(target, code, path, message):
        target.append({"code": code, "path": path, "message": message})

    def error(code, path, message):
        report(errors, code, path, message)

    def warning(code, path, message):
        report(warnings, code, path, message)

    def text(value, path, required=False, maximum=None):
        if value is None and not required:
            return False
        if not isinstance(value, str) or not value.strip():
            error("invalid_text", path, "空でない文字列が必要です。不明な任意項目はnullにしてください")
            return False
        if maximum and len(value.strip()) > maximum:
            error("text_too_long", path, "取り込み側の文字数上限を超えています")
        return True

    def url(value, path, required=False):
        if value is None and not required:
            return None
        try:
            if not isinstance(value, str) or re.search(r"[\s\x00-\x1f]", value):
                raise ValueError()
            parts = urlsplit(value)
            host = (parts.hostname or "").lower().rstrip(".")
            parts.port  # Reject malformed ports as well.
            if parts.scheme not in ("http", "https") or not host or parts.username or parts.password:
                raise ValueError()
            if "." not in host or host.endswith((".localhost", ".local", ".internal")):
                raise ValueError()
            try:
                ipaddress.ip_address(host)
            except ValueError:
                pass
            else:
                raise ValueError()
            # A host is a comparison key only, not a claim about its DNS or ownership.
            return host.removeprefix("www.")
        except (ValueError, TypeError):
            error("invalid_public_url", path, "認証情報を含まない公開HTTP/HTTPSのホスト名URLが必要です")
            return None

    def timestamp(value, path):
        try:
            if not isinstance(value, str) or not re.fullmatch(
                    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value):
                raise ValueError()
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.utcoffset() is None:
                raise ValueError()
        except (ValueError, TypeError):
            error("invalid_timestamp", path, "タイムゾーン付きISO 8601日時が必要です")

    if not isinstance(data, dict):
        error("invalid_root", "$", "JSONオブジェクトが必要です")
        return {"ok": False, "errors": errors, "warnings": warnings}
    criteria = data.get("criteria")
    if not isinstance(criteria, dict):
        error("invalid_criteria", "criteria", "収集条件のオブジェクトが必要です")
        criteria = {}
    for key, maximum in (("prefecture", 10), ("city", 40), ("industry", 60)):
        if key in criteria:
            text(criteria[key], "criteria." + key, required=True, maximum=maximum)
    if criteria.get("city") and not criteria.get("prefecture"):
        error("city_without_prefecture", "criteria.city", "市区町村条件には都道府県も必要です")
    if "cityCode" in criteria and (not isinstance(criteria["cityCode"], str)
                                  or not re.fullmatch(r"[0-9]{5}", criteria["cityCode"])):
        error("invalid_city_code", "criteria.cityCode", "市区町村コードは5桁の文字列です")
    keywords = criteria.get("keywords", [])
    if not isinstance(keywords, list) or len(keywords) > 10:
        error("invalid_keywords", "criteria.keywords", "キーワードは10件以内の配列です")
    else:
        for i, value in enumerate(keywords):
            text(value, f"criteria.keywords[{i}]", required=True, maximum=60)
    if "limit" in criteria:
        warning("ignored_limit", "criteria.limit", "取り込み件数上限はcandidatesの件数から再設定されます")

    if "run" in data:
        run = data["run"]
        if not isinstance(run, dict):
            error("invalid_run", "run", "実行記録はオブジェクトにしてください")
        else:
            timestamp(run.get("started_at"), "run.started_at")
            text(run.get("model"), "run.model", required=True)

    candidates = data.get("candidates")
    if not isinstance(candidates, list) or len(candidates) > 1000:
        error("invalid_candidates", "candidates", "候補は1000件以内の配列です")
        candidates = []
    elif not candidates:
        warning("empty_candidates", "candidates", "取り込む候補はありません。除外一覧のみならDB取り込みを省略できます")
    seen = {"corporate_number": {}, "domain": {}, "name_location": {}}
    candidate_names = set()
    for i, candidate in enumerate(candidates):
        p = f"candidates[{i}]"
        if not isinstance(candidate, dict):
            error("invalid_candidate", p, "候補はオブジェクトです")
            continue
        c = candidate
        has_name = text(c.get("name"), p + ".name", required=True)
        if has_name:
            candidate_names.add(c["name"].strip())
        number = c.get("corporate_number")
        if number is not None and not valid_number(number):
            error("invalid_corporate_number", p + ".corporate_number", "13桁と検査用数字を確認してください。形式合格でも実在確認は別に必要です")
        for key in ("prefecture", "city", "address", "industry", "representative_phone"):
            text(c.get(key), p + "." + key)
        source = url(c.get("address_source_url"), p + ".address_source_url")
        if any(c.get(k) is not None for k in ("prefecture", "city", "address")) and not source:
            error("missing_address_source", p + ".address_source_url", "申告した所在地には確認元URLが必要です")
        if c.get("city") and not c.get("prefecture"):
            error("city_without_prefecture", p + ".city", "申告する市区町村には都道府県も付けてください")
        for key in ("prefecture", "city"):
            actual, expected = c.get(key), criteria.get(key)
            if isinstance(actual, str) and isinstance(expected, str):
                matches = actual == expected if key == "prefecture" else actual.startswith(expected)
                if not matches:
                    error("area_mismatch", p + "." + key, "申告所在地が収集条件と一致しません。修正するか除外してください")
        found = c.get("found_via")
        if not isinstance(found, dict):
            error("missing_found_via", p + ".found_via", "発見元のオブジェクトが必要です")
        else:
            url(found.get("url"), p + ".found_via.url", required=True)
            if "note" in found:
                text(found["note"], p + ".found_via.note")
        timestamp(c.get("fetched_at"), p + ".fetched_at")
        domain = None
        site = c.get("official_site")
        if "official_site" not in c:
            error("missing_official_site", p + ".official_site", "公式サイト不明の場合もnullを明示してください")
        elif site is None:
            warning("no_official_site", p + ".official_site", "国税庁API等でも実在確認できなければ取り込み時に除外されます")
        elif not isinstance(site, dict):
            error("invalid_official_site", p + ".official_site", "公式サイトはオブジェクトまたはnullです")
        else:
            domain = url(site.get("url"), p + ".official_site.url", required=True)
            evidence_domain = url(site.get("evidence_url"), p + ".official_site.evidence_url", required=True)
            if domain and evidence_domain and domain != evidence_domain:
                error("off_site_evidence", p + ".official_site.evidence_url", "別ドメインの根拠ページは取り込み時に取得されません")
            evidence = site.get("evidence")
            if not isinstance(evidence, dict):
                error("invalid_evidence", p + ".official_site.evidence", "ページで読めた情報のオブジェクトが必要です")
            else:
                for key in ("company_name", "address", "corporate_number"):
                    text(evidence.get(key), p + ".official_site.evidence." + key)
                if not evidence.get("company_name"):
                    warning("missing_name_evidence", p + ".official_site.evidence.company_name", "本文で社名を確認できない場合、公式性を確定できません")
        other = c.get("other_sites", [])
        if not isinstance(other, list):
            error("invalid_other_sites", p + ".other_sites", "第三者サイトは配列です")
        else:
            for j, entry in enumerate(other):
                ep = f"{p}.other_sites[{j}]"
                if not isinstance(entry, dict):
                    error("invalid_other_site", ep, "第三者サイトはオブジェクトです")
                    continue
                url(entry.get("url"), ep + ".url", required=True)
                if "third_party" in entry and type(entry["third_party"]) is not bool:
                    error("invalid_boolean", ep + ".third_party", "third_partyは真偽値です")
                elif entry.get("third_party") is False:
                    warning("other_site_not_third_party", ep + ".third_party", "第三者サイトを公式候補に変更しないでください。個別に公式性を確認してください")
        size = c.get("size_check")
        if not isinstance(size, dict):
            warning("missing_size_check", p + ".size_check", "除外条件の確認結果を記録してください。不明はnullと理由を残してください")
        else:
            for key in ("listed", "franchise_or_branch"):
                value = size.get(key)
                if value is not None and type(value) is not bool:
                    error("invalid_size_flag", p + ".size_check." + key, "確認済みは真偽値、不明はnullで記録してください")
                elif value is True:
                    error("excluded_company", p + ".size_check." + key, "除外条件に該当しています。excludedへ移してください")
            claimed = any(size.get(k) is not None for k in ("listed", "franchise_or_branch", "capital", "employees"))
            if claimed and not url(size.get("source_url"), p + ".size_check.source_url"):
                error("missing_size_source", p + ".size_check.source_url", "確認済みの規模・除外条件には根拠URLが必要です")
            if not claimed and not size.get("note"):
                warning("unknown_size_without_note", p + ".size_check.note", "未確認の理由を残してください")
        keys = {"corporate_number": number if valid_number(number) else None, "domain": domain}
        if has_name and isinstance(c.get("prefecture"), str) and isinstance(c.get("city"), str):
            keys["name_location"] = (core_name(c["name"]), c["prefecture"], c["city"])
        for kind, key in keys.items():
            if key is None:
                continue
            if key in seen[kind]:
                target = warnings if kind == "name_location" else errors
                report(target, "duplicate_" + kind, p, f"候補{seen[kind][key]}と識別情報が重複しています。自動統合せず同一企業か確認してください")
            else:
                seen[kind][key] = i

    excluded = data.get("excluded", [])
    if not isinstance(excluded, list):
        error("invalid_excluded", "excluded", "除外一覧は配列です")
    else:
        for i, entry in enumerate(excluded):
            p = f"excluded[{i}]"
            if not isinstance(entry, dict):
                error("invalid_exclusion", p, "除外企業はオブジェクトです")
                continue
            text(entry.get("name"), p + ".name", required=True)
            text(entry.get("reason"), p + ".reason", required=True)
            url(entry.get("source_url"), p + ".source_url", required=True)
            if isinstance(entry.get("name"), str) and entry["name"].strip() in candidate_names:
                warning("candidate_exclusion_overlap", p, "同名企業がcandidatesにもあります。同名別企業か、除外漏れか確認してください")
    return {"ok": not errors, "errors": errors, "warnings": warnings}


def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("JSONオブジェクト内のキーが重複しています")
        obj[key] = value
    return obj


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidates", type=Path)
    args = parser.parse_args()
    try:
        def reject_constant(_value):
            raise ValueError("JSONに非有限数は使用できません")
        data = json.loads(args.candidates.read_text(encoding="utf-8"),
                          object_pairs_hook=unique_object, parse_constant=reject_constant)
        result = validate(data)
    except (OSError, UnicodeError, ValueError):
        result = {"ok": False, "errors": [{"code": "unreadable_json", "path": "$",
                   "message": "JSONを読み取れません。文字コード・構文・重複キー・ファイルの存在を確認してください"}], "warnings": []}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
