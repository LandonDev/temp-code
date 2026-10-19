#!/usr/bin/env python3
"""Exercise stage ordering and SSH stdin isolation without contacting the box."""
from pathlib import Path
import os
import subprocess
import tempfile

here = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix="box-apply-test-") as root:
    root = Path(root)
    # SSH intentionally drains stdin, as real ssh does. It must never eat the
    # stage list when a stage or the Mac-side tunnel helper runs.
    for name, code in {
        "ssh": "#!/usr/bin/env python3\nimport sys\nsys.stdin.read()\n",
        "rsync": "#!/bin/sh\nexit 0\n",
        "cloudflared": "#!/bin/sh\nexit 0\n",
    }.items():
        p = root / name
        p.write_text(code)
        p.chmod(0o755)
    env = dict(os.environ, PATH=str(root) + ":" + os.environ["PATH"])
    for start, end, expected in (
        (100, 190, [100, 110, 120, 130, 140, 150, 190]),
        (120, 130, [120, 130]),
        (190, 190, [190]),
    ):
        run = subprocess.run(["bash", str(here / "apply.sh"), "--from", str(start),
                              "--through", str(end)], env=env, input="", text=True,
                             capture_output=True, check=True, timeout=15)
        stages = [int(line.split()[1].split("-")[0]) for line in run.stdout.splitlines()
                  if line.startswith("== ")]
        assert stages == expected, (stages, expected)
print("PASS: production stage order, range limits, and SSH stdin isolation")
