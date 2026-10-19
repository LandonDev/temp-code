#!/usr/bin/env python3
"""Run on the box: prove the generated admin can log in over HTTP."""
from html import unescape
from http.cookiejar import CookieJar
from pathlib import Path
import re
from urllib.parse import urlencode, urlparse
from urllib.request import build_opener, HTTPCookieProcessor, Request

credentials = dict(line.split("=", 1) for line in
                   Path("/srv/prod/secrets/coolify-admin.env").read_text().splitlines())
opener = build_opener(HTTPCookieProcessor(CookieJar()))
origin = "http://127.0.0.1:8000"
with opener.open(origin + "/login", timeout=15) as response:
    page = response.read().decode()
token = re.search(r'name="_token"\s+value="([^"]+)"', page)
assert token, "Login CSRF token missing"
data = urlencode({"_token": unescape(token.group(1)),
                  "email": credentials["ROOT_USER_EMAIL"],
                  "password": credentials["ROOT_USER_PASSWORD"]}).encode()
with opener.open(Request(origin + "/login", data=data), timeout=30) as response:
    assert response.status == 200, "Admin login failed"
    assert urlparse(response.url).path not in ("/login", "/register"), "Admin login rejected"
print("PASS: generated Coolify admin authenticated over HTTP")
